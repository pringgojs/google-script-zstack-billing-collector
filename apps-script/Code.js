/**
 * Starter Apps Script: fetch ZStack daily billing and insert into BigQuery.
 * Configure Script Properties: ZSTACK_API_URL, (ZSTACK_API_KEY) or (ZSTACK_ACCESS_KEY + ZSTACK_ACCESS_SECRET), BQ_PROJECT, BQ_DATASET, BQ_TABLE
 * Requirements:
 *  - Enable BigQuery Advanced Service in Apps Script
 *  - Add OAuth scopes in appsscript.json
 */
function collectBillingDaily() {
  var props = PropertiesService.getScriptProperties();
  var apiUrl = props.getProperty("ZSTACK_API_URL") || "";
  var apiKey = props.getProperty("ZSTACK_API_KEY") || "";
  var accessKey = props.getProperty("ZSTACK_ACCESS_KEY") || "";
  var accessSecret = props.getProperty("ZSTACK_ACCESS_SECRET") || "";
  var username = props.getProperty("ZSTACK_USERNAME") || "";
  var password = props.getProperty("ZSTACK_PASSWORD") || "";
  var extraQuery = props.getProperty("ZSTACK_EXTRA_QUERY") || ""; // e.g. "Action=DescribeBilling&Version=2016-01-01"
  var projectId = props.getProperty("BQ_PROJECT") || "";
  var datasetId = props.getProperty("BQ_DATASET") || "";
  var tableId = props.getProperty("BQ_TABLE") || "";
  var accountUuid = props.getProperty("ZSTACK_ACCOUNT_UUID") || "";
  var billingPath =
    props.getProperty("ZSTACK_BILLING_PATH") || "/zstack/v1/billings/accounts";

  // If username/password are provided, attempt login once to obtain session token and account UUID
  var sessionToken = "";
  if (username && password) {
    var loginRes = loginZstack(apiUrl, username, password);
    if (loginRes) {
      sessionToken = loginRes.token || loginRes.uuid || "";
      // prefer accountUuid from login response when available
      if (loginRes.accountUuid)
        accountUuid = accountUuid || loginRes.accountUuid;
      if (loginRes.uuid && !accountUuid) accountUuid = loginRes.uuid;
    }
  }

  if (
    !apiUrl ||
    !(apiKey || (accessKey && accessSecret) || (username && password)) ||
    !projectId ||
    !datasetId ||
    !tableId
  ) {
    throw new Error(
      "Missing script properties. Set ZSTACK_API_URL and either ZSTACK_API_KEY or (ZSTACK_ACCESS_KEY + ZSTACK_ACCESS_SECRET), and BQ_PROJECT, BQ_DATASET, BQ_TABLE"
    );
  }

  var today = new Date();
  var billingDate = Utilities.formatDate(today, "UTC", "yyyy-MM-dd");
  var rowsBatch = [];

  // Ensure the destination BigQuery table exists with a proper schema
  ensureBQTable(projectId, datasetId, tableId);

  // billing API expects epoch ms dateStart/dateEnd. Build for billingDate (UTC full day)
  var start = new Date(billingDate + "T00:00:00Z");
  var end = new Date(billingDate + "T23:59:59.999Z");
  var dateStartMs = start.getTime();
  var dateEndMs = end.getTime();

  // build billing URL: {apiUrl}/{billingPath}/{accountUuid}/actions
  if (!accountUuid) {
    throw new Error("Missing ZSTACK_ACCOUNT_UUID in Script Properties");
  }
  var base = apiUrl.replace(/\/$/, "");
  var url = base + billingPath + "/" + accountUuid + "/actions";
  if (extraQuery) {
    url += (url.indexOf("?") === -1 ? "?" : "&") + extraQuery;
  }
  // Build auth headers: prefer API key (Bearer), otherwise use AccessKey/AccessSecret headers
  var headers = {};
  if (apiKey) {
    headers.Authorization = "Bearer " + apiKey;
  } else if (accessKey && accessSecret) {
    // Use custom headers expected by ZStack (adjust names if your ZStack expects different header names)
    headers["X-Access-Key"] = accessKey;
    headers["X-Access-Secret"] = accessSecret;
  } else if (username && password) {
    // Use session token from earlier login if available
    if (sessionToken) {
      headers.Authorization = "OAuth " + sessionToken;
    } else {
      // fallback to Basic header if login didn't return a token
      var basic = Utilities.base64Encode(username + ":" + password);
      headers.Authorization = "Basic " + basic;
    }
  }

  var body = {
    calculateAccountSpending: {
      dateStart: dateStartMs,
      dateEnd: dateEndMs,
    },
    systemTags: [],
    userTags: [],
  };

  var options = {
    method: "put",
    contentType: "application/json",
    payload: JSON.stringify(body),
    headers: headers,
    muteHttpExceptions: true,
  };

  var resp = UrlFetchApp.fetch(url, options);
  var code = resp.getResponseCode();
  if (code >= 400) {
    throw new Error("ZStack API error: " + resp.getContentText());
  }

  var payload = JSON.parse(resp.getContentText());

  // payload.spending is an array; iterate and convert to rows
  var spending = payload.spending || [];
  spending.forEach(function (sp) {
    var spendingType = sp.spendingType || "";
    var dateStart = sp.dateStart || dateStartMs;
    var dateEnd = sp.dateEnd || dateEndMs;
    var details = sp.details || [];
    details.forEach(function (detail) {
      var resourceId = detail.resourceUuid || "";
      var resourceName = detail.resourceName || "";
      var resourceType = detail.type || spendingType || "";
      var cost = Number(detail.spending || detail.spending || 0);
      var row = {
        json: {
          billing_date: billingDate,
          account_id: accountUuid,
          resource_id: resourceId,
          resource_name: resourceName,
          spending_type: spendingType,
          resource_type: resourceType,
          cost: cost,
          date_start_ms: dateStart,
          date_end_ms: dateEnd,
          raw_json: JSON.stringify(detail),
          collected_at: new Date().toISOString(),
        },
      };
      rowsBatch.push(row);
    });
  });

  if (rowsBatch.length) {
    insertRowsToBQ(projectId, datasetId, tableId, rowsBatch);
    rowsBatch = [];
  }

  return { status: "ok" };
}

function insertRowsToBQ(projectId, datasetId, tableId, rows) {
  var insertAllRequest = { rows: rows };
  var resp = BigQuery.Tabledata.insertAll(
    insertAllRequest,
    projectId,
    datasetId,
    tableId
  );
  if (resp.insertErrors && resp.insertErrors.length) {
    Logger.log("BigQuery insert errors: %s", JSON.stringify(resp.insertErrors));
    // Try to fetch and log table schema for diagnosis
    try {
      var table = BigQuery.Tables.get(projectId, datasetId, tableId);
      Logger.log("Table schema: %s", JSON.stringify(table.schema || {}));
    } catch (e) {
      Logger.log("Failed to fetch table schema: %s", e.toString());
    }
    throw new Error(
      "BigQuery insertAll returned errors: " + JSON.stringify(resp.insertErrors)
    );
  }
  return resp;
}

/**
 * Get and log BigQuery table schema for given identifiers.
 */
function getBQTableSchema(projectId, datasetId, tableId) {
  try {
    var table = BigQuery.Tables.get(projectId, datasetId, tableId);
    Logger.log(
      "Table %s.%s.%s schema: %s",
      projectId,
      datasetId,
      tableId,
      JSON.stringify(table.schema || {})
    );
    return table.schema || null;
  } catch (e) {
    Logger.log("getBQTableSchema error: %s", e.toString());
    throw e;
  }
}

/**
 * Test inserting a single sample row into configured BQ table.
 * Use Script Properties: BQ_PROJECT, BQ_DATASET, BQ_TABLE
 */
function testInsertToBQ() {
  var props = PropertiesService.getScriptProperties();
  var projectId = props.getProperty("BQ_PROJECT") || "";
  var datasetId = props.getProperty("BQ_DATASET") || "";
  var tableId = props.getProperty("BQ_TABLE") || "";
  if (!projectId || !datasetId || !tableId)
    throw new Error(
      "Set BQ_PROJECT, BQ_DATASET, BQ_TABLE in Script Properties"
    );

  // Ensure table exists
  ensureBQTable(projectId, datasetId, tableId);

  // Log current schema
  try {
    getBQTableSchema(projectId, datasetId, tableId);
  } catch (e) {
    Logger.log(
      "Could not retrieve schema before test insert: %s",
      e.toString()
    );
  }

  var sampleRow = [
    {
      json: {
        billing_date: Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd"),
        account_id: "test-account",
        resource_id: "test-resource",
        resource_name: "test-resource-name",
        spending_type: "VM",
        resource_type: "VM",
        cost: 0.01,
        date_start_ms: Date.now(),
        date_end_ms: Date.now(),
        raw_json: JSON.stringify({ test: true }),
        collected_at: new Date().toISOString(),
      },
    },
  ];

  try {
    var res = insertRowsToBQ(projectId, datasetId, tableId, sampleRow);
    Logger.log("testInsertToBQ result: %s", JSON.stringify(res));
    return res;
  } catch (e) {
    Logger.log("testInsertToBQ failed: %s", e.toString());
    throw e;
  }
}

/**
 * Ensure BigQuery table exists with a schema; create it if missing.
 */
function ensureBQTable(projectId, datasetId, tableId) {
  try {
    BigQuery.Tables.get(projectId, datasetId, tableId);
    return;
  } catch (e) {
    // If not found, create table with recommended schema
    Logger.log(
      "Table %s.%s.%s not found, creating...",
      projectId,
      datasetId,
      tableId
    );
    var tableResource = {
      tableReference: {
        projectId: projectId,
        datasetId: datasetId,
        tableId: tableId,
      },
      friendlyName: "ZStack billing daily",
      description: "Daily billing rows imported from ZStack",
      schema: {
        fields: [
          { name: "billing_date", type: "DATE" },
          { name: "account_id", type: "STRING" },
          { name: "resource_id", type: "STRING" },
          { name: "resource_name", type: "STRING" },
          { name: "spending_type", type: "STRING" },
          { name: "resource_type", type: "STRING" },
          { name: "cost", type: "FLOAT" },
          { name: "date_start_ms", type: "INTEGER" },
          { name: "date_end_ms", type: "INTEGER" },
          { name: "raw_json", type: "STRING" },
          { name: "collected_at", type: "TIMESTAMP" },
        ],
      },
      timePartitioning: { type: "DAY", field: "billing_date" },
    };

    try {
      BigQuery.Tables.insert(tableResource, projectId, datasetId);
      Logger.log("Created table %s.%s.%s", projectId, datasetId, tableId);
    } catch (err) {
      Logger.log("Failed to create table: %s", err.toString());
      throw err;
    }
  }
}

/**
 * Login to ZStack using account name + password.
 * ZStack expects the password to be SHA-512 hex digest.
 * Returns session token/uuid if found, otherwise null.
 */
function loginZstack(apiUrl, username, password) {
  try {
    var loginPath =
      PropertiesService.getScriptProperties().getProperty(
        "ZSTACK_LOGIN_PATH"
      ) || "/zstack/v1/accounts/login";
    var url = apiUrl.replace(/\/$/, "") + loginPath;
    var hashed = sha512Hex(password);
    var payload = {
      logInByAccount: { accountName: username, password: hashed },
    };
    var options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };
    var resp = UrlFetchApp.fetch(url, options);
    var code = resp.getResponseCode();
    if (code >= 400) {
      Logger.log("Login failed: %s", resp.getContentText());
      return null;
    }
    var obj = JSON.parse(resp.getContentText());

    // Prefer inventory.uuid as session token and inventory.accountUuid as account identifier
    var token = null;
    var accountUuid = null;

    if (obj && typeof obj === "object") {
      if (obj.inventory) {
        if (obj.inventory.uuid) token = obj.inventory.uuid;
        if (obj.inventory.accountUuid) accountUuid = obj.inventory.accountUuid;
        if (!accountUuid && obj.inventory.userUuid)
          accountUuid = obj.inventory.userUuid;
      }

      // other fallbacks
      if (!token && obj.uuid) token = obj.uuid;
      if (!token && obj.session)
        token =
          typeof obj.session === "string"
            ? obj.session
            : obj.session.uuid || null;
      if (!token && obj.value && obj.value.uuid) token = obj.value.uuid;
      if (!accountUuid && obj.accountUuid) accountUuid = obj.accountUuid;

      // recursive search fallback for first uuid-like string
      function findUuid(o) {
        if (!o) return null;
        if (typeof o === "string") {
          if (/^[0-9a-f]{32}$/i.test(o)) return o;
          return null;
        }
        if (typeof o === "object") {
          for (var k in o) {
            if (!o.hasOwnProperty(k)) continue;
            var v = o[k];
            if (typeof v === "string" && /^[0-9a-f]{32}$/i.test(v)) return v;
            var sub = findUuid(v);
            if (sub) return sub;
          }
        }
        return null;
      }

      if (!token) token = findUuid(obj);
      if (!accountUuid) accountUuid = findUuid(obj);
    } else if (typeof obj === "string") {
      token = obj;
    }

    Logger.log(
      "loginZstack parsed token=%s accountUuid=%s",
      token,
      accountUuid
    );
    return {
      token: token || null,
      accountUuid: accountUuid || null,
      uuid: token || accountUuid || null,
    };
  } catch (e) {
    Logger.log("loginZstack error: %s", e.toString());
    return null;
  }
}

function sha512Hex(str) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_512,
    str,
    Utilities.Charset.UTF_8
  );
  var out = "";
  for (var i = 0; i < digest.length; i++) {
    var h = (digest[i] < 0 ? digest[i] + 256 : digest[i]).toString(16);
    if (h.length === 1) h = "0" + h;
    out += h;
  }

  Logger.log("sha512Hex hashed: %s", out);
  return out;
}

/**
 * Test function to validate auth/login to ZStack without writing to BigQuery.
 */
function testZstackAuth() {
  var props = PropertiesService.getScriptProperties();
  var apiUrl = props.getProperty("ZSTACK_API_URL") || "";
  var username = props.getProperty("ZSTACK_USERNAME") || "";
  var password = props.getProperty("ZSTACK_PASSWORD") || "";
  var accessKey = props.getProperty("ZSTACK_ACCESS_KEY") || "";
  var accessSecret = props.getProperty("ZSTACK_ACCESS_SECRET") || "";
  var apiKey = props.getProperty("ZSTACK_API_KEY") || "";

  if (!apiUrl) throw new Error("Set ZSTACK_API_URL in Script Properties");

  if (username && password) {
    var token = loginZstack(apiUrl, username, password);
    Logger.log("login token: %s", token);
    return token;
  }

  // try a simple ping with available creds
  var headers = {};
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  else if (accessKey && accessSecret) {
    headers["X-Access-Key"] = accessKey;
    headers["X-Access-Secret"] = accessSecret;
  }
  var url = apiUrl.replace(/\/$/, "") + "/v1";
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: "get",
      headers: headers,
      muteHttpExceptions: true,
    });
    Logger.log(
      "status: %s body: %s",
      resp.getResponseCode(),
      resp.getContentText()
    );
    return resp.getContentText();
  } catch (e) {
    Logger.log("testZstackAuth error: %s", e.toString());
    throw e;
  }
}
