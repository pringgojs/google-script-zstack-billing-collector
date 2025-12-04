/**
 * Starter Apps Script: fetch ZStack daily billing and insert into BigQuery.
 * Configure Script Properties: ZSTACK_API_URL, (ZSTACK_API_KEY) or (ZSTACK_ACCESS_KEY + ZSTACK_ACCESS_SECRET), BQ_PROJECT, BQ_DATASET, BQ_TABLE
 * Requirements:
 *  - Enable BigQuery Advanced Service in Apps Script
 *  - Add OAuth scopes in appsscript.json
 */
function collectBillingDaily() {
  var today = new Date();
  var yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  // Use Asia/Jakarta (UTC+7) as requested
  var TZ = "Asia/Jakarta";
  var billingDate = Utilities.formatDate(yesterday, TZ, "yyyy-MM-dd");
  return collectBillingForDate(billingDate);
}

// In-memory cache to avoid repeated login requests within the same execution
var ZSTACK_CACHE = { token: null, accountUuid: null, fetchedAtSec: 0 };

/**
 * Collect billing for a specific date string (YYYY-MM-DD).
 * This is useful for manual backfills or testing.
 */
function collectBillingForDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string")
    throw new Error("dateStr must be provided as YYYY-MM-DD");

  // Copy of main logic but using provided date
  var props = PropertiesService.getScriptProperties();
  var apiUrl = props.getProperty("ZSTACK_API_URL") || "";
  var apiKey = props.getProperty("ZSTACK_API_KEY") || "";
  var accessKey = props.getProperty("ZSTACK_ACCESS_KEY") || "";
  var accessSecret = props.getProperty("ZSTACK_ACCESS_SECRET") || "";
  var username = props.getProperty("ZSTACK_USERNAME") || "";
  var password = props.getProperty("ZSTACK_PASSWORD") || "";
  var extraQuery = props.getProperty("ZSTACK_EXTRA_QUERY") || "";
  var projectId = props.getProperty("BQ_PROJECT") || "";
  var datasetId = props.getProperty("BQ_DATASET") || "";
  var tableId = props.getProperty("BQ_TABLE") || "";
  var accountUuid = props.getProperty("ZSTACK_ACCOUNT_UUID") || "";
  var billingPath =
    props.getProperty("ZSTACK_BILLING_PATH") || "/zstack/v1/billings/accounts";

  var sessionToken = "";
  if (username && password) {
    var loginRes = loginZstack(apiUrl, username, password);
    if (loginRes) {
      sessionToken = loginRes.token || loginRes.uuid || "";
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

  var billingDate = dateStr;
  var rowsBatch = [];

  ensureBQTable(projectId, datasetId, tableId);

  // Build start/end at midnight in UTC+7 (Asia/Jakarta) and use epoch milliseconds (13 digits)
  var start = new Date(billingDate + "T00:00:00.000+07:00");
  var end = new Date(billingDate + "T23:59:59.999+07:00");
  var dateStartMs = start.getTime();
  var dateEndMs = end.getTime();
  // Ensure integers (avoid any float/scientific notation)
  dateStartMs = parseInt(dateStartMs, 10);
  dateEndMs = parseInt(dateEndMs, 10);
  // Log epoch start/end (milliseconds) for diagnostics
  Logger.log(
    "Billing date %s -> dateStart=%s dateEnd=%s (epoch ms)",
    billingDate,
    String(dateStartMs),
    String(dateEndMs)
  );

  if (!accountUuid) {
    throw new Error("Missing ZSTACK_ACCOUNT_UUID in Script Properties");
  }
  var base = apiUrl.replace(/\/$/, "");
  var url = base + billingPath + "/" + accountUuid + "/actions";
  if (extraQuery) url += (url.indexOf("?") === -1 ? "?" : "&") + extraQuery;

  var headers = {};
  if (apiKey) {
    headers.Authorization = "Bearer " + apiKey;
  } else if (accessKey && accessSecret) {
    headers["X-Access-Key"] = accessKey;
    headers["X-Access-Secret"] = accessSecret;
  } else if (username && password) {
    if (sessionToken) {
      headers.Authorization = "OAuth " + sessionToken;
    } else {
      var basic = Utilities.base64Encode(username + ":" + password);
      headers.Authorization = "Basic " + basic;
    }
  }

  // ZStack expects milliseconds since epoch (integer) for this environment
  var body = {
    calculateAccountSpending: {
      // ensure plain integer numbers (ms)
      dateStart: dateStartMs,
      dateEnd: dateEndMs,
    },
    systemTags: [],
    userTags: [],
  };
  // Log payload with explicit string conversion for large numbers to avoid scientific notation in logs
  var bodyForLog = {
    calculateAccountSpending: {
      dateStart: String(dateStartMs),
      dateEnd: String(dateEndMs),
    },
    systemTags: [],
    userTags: [],
  };
  Logger.log("Request payload: %s", JSON.stringify(bodyForLog));

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
  var spending = payload.spending || [];
  spending.forEach(function (sp) {
    var spendingType = sp.spendingType || "";
    // ZStack returns dateStart/dateEnd in seconds; fall back to our computed seconds
    // ZStack returns dateStart/dateEnd in milliseconds (ms) for this setup; fall back to our computed ms
    var dateStart = parseInt(sp.dateStart || dateStartMs, 10);
    var dateEnd = parseInt(sp.dateEnd || dateEndMs, 10);
    var details = sp.details || [];
    details.forEach(function (detail) {
      var resourceId = detail.resourceUuid || "";
      var resourceName = detail.resourceName || "";
      var resourceType = detail.type || spendingType || "";

      // Look for inventory arrays (sizeInventory, cpuInventory, memoryInventory, etc.)
      var inventoryKeys = Object.keys(detail).filter(function (k) {
        return Array.isArray(detail[k]) && /Inventory$/i.test(k);
      });

      if (inventoryKeys.length) {
        inventoryKeys.forEach(function (invKey) {
          var invArr = detail[invKey] || [];
          invArr.forEach(function (inv) {
            var invStart = parseInt(inv.startTime || dateStart, 10);
            var invEnd = parseInt(inv.endTime || dateEnd, 10);
            var invCost = Number(inv.spending || 0);
            var row = {
              json: {
                billing_date: billingDate,
                account_id: accountUuid,
                resource_id: resourceId,
                resource_name: resourceName,
                spending_type: spendingType,
                resource_type: resourceType,
                inventory_type: invKey,
                cost: invCost,
                date_start_ms: invStart,
                date_end_ms: invEnd,
                collected_at: new Date().toISOString(),
              },
            };
            rowsBatch.push(row);
          });
        });
      } else {
        // Fallback: no specific inventory arrays, use detail.spending and group-level start/end
        var cost = Number(detail.spending || sp.spending || 0);
        var row = {
          json: {
            billing_date: billingDate,
            account_id: accountUuid,
            resource_id: resourceId,
            resource_name: resourceName,
            spending_type: spendingType,
            resource_type: resourceType,
            inventory_type: null,
            cost: cost,
            date_start_ms: dateStart,
            date_end_ms: dateEnd,
            raw_json: JSON.stringify(detail),
            collected_at: new Date().toISOString(),
          },
        };
        rowsBatch.push(row);
      }
    });
  });

  if (rowsBatch.length) {
    replaceRowsForDate(projectId, datasetId, tableId, billingDate, rowsBatch);
  }

  return { status: "ok", date: billingDate };
}

/**
 * Collect billing for every day in a given month.
 * Parameter format: "YYYY-MM" (e.g. "2025-11").
 * This is intended for testing/backfill and will call `collectBillingForDate` for each day.
 */
function collectBillingForMonth(yearMonth) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new Error("yearMonth must be provided in YYYY-MM format");
  }
  var parts = yearMonth.split("-");
  var y = Number(parts[0]);
  var m = Number(parts[1]);
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
    throw new Error("Invalid yearMonth");
  }

  // Determine number of days in month
  var lastDay = new Date(y, m, 0).getDate();
  var results = [];
  for (var d = 1; d <= lastDay; d++) {
    // Build YYYY-MM-DD directly so it represents the calendar day in Asia/Jakarta
    var mm = m < 10 ? "0" + m : "" + m;
    var dd = d < 10 ? "0" + d : "" + d;
    var dateStr = y + "-" + mm + "-" + dd;
    Logger.log("Collecting billing for %s", dateStr);
    try {
      var res = collectBillingForDate(dateStr);
      results.push({ date: dateStr, ok: true, res: res });
    } catch (e) {
      Logger.log(
        "collectBillingForDate failed for %s: %s",
        dateStr,
        e.toString()
      );
      results.push({ date: dateStr, ok: false, error: e.toString() });
    }
    // Small sleep to avoid hitting rate limits
    Utilities.sleep(1000);
  }
  return results;
}

/**
 * Helper: collect billing for the previous month (useful for quick tests).
 */
function collectBillingForPreviousMonth() {
  var now = new Date();
  // move to first day of this month, then go back one day to get last day of previous month
  var firstOfThisMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  var lastOfPrev = new Date(firstOfThisMonth.getTime() - 24 * 60 * 60 * 1000);
  // Use Asia/Jakarta (UTC+7)
  var ym = Utilities.formatDate(lastOfPrev, "Asia/Jakarta", "yyyy-MM");
  return collectBillingForMonth(ym);
}

/**
 * Runner helpers to avoid passing complex JSON params from PowerShell/CLI.
 * - `runCollectBillingForMonthStatic` calls `collectBillingForMonth` with a hard-coded example.
 * - `runCollectBillingForMonthFromProperty` reads `COLLECT_TEST_MONTH` Script Property (YYYY-MM) and runs it.
 */
function runCollectBillingForMonthStatic() {
  // Change this value for testing different months without using --params
  return collectBillingForMonth("2025-11");
}

function runCollectBillingForMonthFromProperty() {
  var props = PropertiesService.getScriptProperties();
  var ym = props.getProperty("COLLECT_TEST_MONTH");
  if (!ym)
    throw new Error(
      "Set Script Property COLLECT_TEST_MONTH to YYYY-MM (e.g. 2025-11)"
    );
  return collectBillingForMonth(ym);
}

/**
 * Replace rows in BigQuery for a given billing_date: DELETE then INSERT.
 */
function replaceRowsForDate(projectId, datasetId, tableId, billingDate, rows) {
  // Delete existing rows for that date first
  try {
    deleteRowsForDate(projectId, datasetId, tableId, billingDate);
  } catch (e) {
    Logger.log("deleteRowsForDate warning: %s", e.toString());
    // continue to attempt insert even if delete failed; user should inspect permissions
  }

  // Insert new rows
  return insertRowsToBQ(projectId, datasetId, tableId, rows);
}

/**
 * Run a BigQuery DELETE query to remove rows for billing_date.
 */
function deleteRowsForDate(projectId, datasetId, tableId, billingDate) {
  var sql =
    "DELETE FROM `" +
    projectId +
    "." +
    datasetId +
    "." +
    tableId +
    "` WHERE billing_date = DATE '" +
    billingDate +
    "'";
  Logger.log("Running delete query: %s", sql);
  var req = { query: sql, useLegacySql: false };
  var resp = BigQuery.Jobs.query(req, projectId);
  if (resp && resp.errorResult) {
    throw new Error(
      "BigQuery delete error: " + JSON.stringify(resp.errorResult)
    );
  }
  Logger.log("Delete job result: %s", JSON.stringify(resp || {}));
  return resp;
}

/**
 * Create triggers examples (call once from editor) — helper functions.
 */
function createHourlyTriggerAtTopOfHour() {
  // Triggers run approximately on schedule; this creates a simple hourly trigger.
  ScriptApp.newTrigger("collectBillingDaily")
    .timeBased()
    .everyHours(1)
    .create();
  return "Created hourly trigger (everyHours(1)).";
}

function createDailyMidnightTrigger() {
  // Run every day at approximately 00:00 (UTC local) - Apps Script may vary by minutes.
  ScriptApp.newTrigger("collectBillingDaily")
    .timeBased()
    .atHour(0)
    .everyDays(1)
    .create();
  return "Created daily midnight trigger (atHour(0) everyDays(1)).";
}

function insertRowsToBQ(projectId, datasetId, tableId, rows) {
  var insertAllRequest = { rows: rows };
  var maxRetries = 3;
  var attempt = 0;
  var lastErr = null;
  while (attempt < maxRetries) {
    attempt++;
    try {
      var resp = BigQuery.Tabledata.insertAll(
        insertAllRequest,
        projectId,
        datasetId,
        tableId
      );
      if (resp.insertErrors && resp.insertErrors.length) {
        Logger.log(
          "BigQuery insert errors (attempt %s): %s",
          attempt,
          JSON.stringify(resp.insertErrors)
        );
        lastErr = new Error(
          "BigQuery insertAll returned errors: " +
            JSON.stringify(resp.insertErrors)
        );
        // if schema related, fetch schema for diagnosis and retry
        try {
          var table = BigQuery.Tables.get(projectId, datasetId, tableId);
          Logger.log("Table schema: %s", JSON.stringify(table.schema || {}));
        } catch (e) {
          Logger.log("Failed to fetch table schema: %s", e.toString());
        }
        // if final attempt, throw
        if (attempt >= maxRetries) throw lastErr;
        Utilities.sleep(3000);
        continue;
      }
      // success
      return resp;
    } catch (e) {
      lastErr = e;
      var msg = e && e.message ? e.message : e.toString ? e.toString() : "";
      Logger.log("insertRowsToBQ attempt %s failed: %s", attempt, msg);
      // if error mentions no schema or table not found, try to get schema and wait then retry
      if (
        /no schema/i.test(msg) ||
        /Table .* has no schema/i.test(msg) ||
        /destination table has no schema/i.test(msg) ||
        /Table .* not found/i.test(msg) ||
        /not found/i.test(msg)
      ) {
        try {
          var table2 = BigQuery.Tables.get(projectId, datasetId, tableId);
          Logger.log(
            "Schema on retry: %s",
            JSON.stringify(table2.schema || {})
          );
        } catch (e2) {
          Logger.log(
            "Failed to fetch table schema on retry: %s",
            e2.toString()
          );
        }
        if (attempt >= maxRetries) throw e;
        Utilities.sleep(3000);
        continue;
      }
      // non-retryable error
      throw e;
    }
  }
  // if we exit loop, throw last error
  throw lastErr;
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
        inventory_type: "cpuInventory",
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
          { name: "inventory_type", type: "STRING" },
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
    var props = PropertiesService.getScriptProperties();
    var loginPath =
      props.getProperty("ZSTACK_LOGIN_PATH") || "/zstack/v1/accounts/login";
    var url = apiUrl.replace(/\/$/, "") + loginPath;

    // TTL for cached token in seconds (script property optional), default 24h
    var ttl = parseInt(
      props.getProperty("ZSTACK_TOKEN_TTL_SEC") || "86400",
      10
    );
    var nowSec = Math.floor(Date.now() / 1000);

    // Return in-memory cached token if present and fresh
    if (
      ZSTACK_CACHE &&
      ZSTACK_CACHE.token &&
      nowSec - ZSTACK_CACHE.fetchedAtSec < ttl
    ) {
      return {
        token: ZSTACK_CACHE.token,
        accountUuid: ZSTACK_CACHE.accountUuid,
        uuid: ZSTACK_CACHE.token,
      };
    }

    // Check Script Properties cache
    var cachedToken = props.getProperty("ZSTACK_CACHED_TOKEN");
    var cachedTs = parseInt(
      props.getProperty("ZSTACK_CACHED_TOKEN_TS") || "0",
      10
    );
    var cachedAccount = props.getProperty("ZSTACK_CACHED_ACCOUNT_UUID") || null;
    if (cachedToken && cachedTs && nowSec - cachedTs < ttl) {
      // populate in-memory cache and return
      ZSTACK_CACHE.token = cachedToken;
      ZSTACK_CACHE.accountUuid = cachedAccount;
      ZSTACK_CACHE.fetchedAtSec = cachedTs;
      Logger.log(
        "loginZstack using cached token (props) age=%s sec",
        nowSec - cachedTs
      );
      return {
        token: cachedToken,
        accountUuid: cachedAccount,
        uuid: cachedToken,
      };
    }

    // perform login
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
      if (!token && obj.uuid) token = obj.uuid;
      if (!token && obj.session)
        token =
          typeof obj.session === "string"
            ? obj.session
            : obj.session.uuid || null;
      if (!token && obj.value && obj.value.uuid) token = obj.value.uuid;
      if (!accountUuid && obj.accountUuid) accountUuid = obj.accountUuid;

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

    // cache to in-memory and Script Properties
    if (token) {
      ZSTACK_CACHE.token = token;
      ZSTACK_CACHE.accountUuid = accountUuid || null;
      ZSTACK_CACHE.fetchedAtSec = nowSec;
      try {
        props.setProperty("ZSTACK_CACHED_TOKEN", token);
        props.setProperty("ZSTACK_CACHED_TOKEN_TS", String(nowSec));
        if (accountUuid)
          props.setProperty("ZSTACK_CACHED_ACCOUNT_UUID", accountUuid);
      } catch (e) {
        Logger.log(
          "Warning: failed to persist cached token in ScriptProperties: %s",
          e.toString()
        );
      }
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
