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
    throw new Error(
      "BigQuery insertAll returned errors: " + JSON.stringify(resp.insertErrors)
    );
  }
  return resp;
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
    // Attempt to extract both a token (session uuid) and an account UUID
    var token = null;
    var accountUuid = null;

    if (typeof obj === "string") {
      token = obj;
    } else {
      if (obj.uuid) token = obj.uuid;
      if (!token && obj.session)
        token =
          typeof obj.session === "string"
            ? obj.session
            : obj.session.uuid || null;
      if (!token && obj.value && obj.value.uuid) token = obj.value.uuid;

      if (obj.inventory && obj.inventory.uuid) accountUuid = obj.inventory.uuid;
      if (!accountUuid && obj.account && obj.account.uuid)
        accountUuid = obj.account.uuid;
      if (!accountUuid && obj.accountUuid) accountUuid = obj.accountUuid;

      // fallback: recursively search for first 32-hex uuid-like string
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

      if (!accountUuid) accountUuid = findUuid(obj);
      if (!token) token = findUuid(obj);
    }

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
