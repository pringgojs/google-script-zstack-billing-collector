# Apps Script starter (zstack-billing)

Quick notes:

- Configure Script Properties: `ZSTACK_API_URL`, `ZSTACK_API_KEY`, `BQ_PROJECT`, `BQ_DATASET`, `BQ_TABLE`.
- Enable BigQuery Advanced Service in the Apps Script project (manifest already references it).
- To push from local using `clasp`:

```powershell
clasp push
clasp run --function collectBillingDaily
```

If you need to set Script Properties from local, use the Apps Script UI or the clasp API.

**Setup & Testing**

- **Script Properties (Apps Script project -> Project settings -> Script properties):**
  - `ZSTACK_API_URL` — base URL for ZStack (e.g. `http://host:8080/zstack`)
  - authentication: one of:
    - `ZSTACK_API_KEY` (Bearer token) OR
    - `ZSTACK_ACCESS_KEY` + `ZSTACK_ACCESS_SECRET` OR
    - `ZSTACK_USERNAME` + `ZSTACK_PASSWORD` (password will be SHA-512 hashed by the script)
  - `ZSTACK_LOGIN_PATH` (optional) — default `/zstack/v1/accounts/login`
  - `ZSTACK_BILLING_PATH` (optional) — default `/zstack/v1/billings/accounts`
  - `ZSTACK_EXTRA_QUERY` (optional) — extra query string appended to billing request
  - `BQ_PROJECT`, `BQ_DATASET`, `BQ_TABLE` — BigQuery target identifiers

**Run quick auth test**

```powershell
cd d:\laragon-www\elitery\zstack-billing\apps-script
clasp push
clasp run --function testZstackAuth
```

**Test insert to BigQuery**

- The repository includes `testInsertToBQ()` which will create the table (if missing), log its schema and try a single sample insert.

```powershell
clasp run --function testInsertToBQ
```

**Troubleshooting common errors**

- "The destination table has no schema" or "Table ... not found": the script now attempts to create the table and will retry insert briefly to handle eventual consistency. If the problem persists, check:
  - The account running Apps Script has `BigQuery Data Editor` and `BigQuery Job User` (or equivalent) on the dataset.
  - The `BQ_PROJECT`, `BQ_DATASET`, `BQ_TABLE` values match the project where the script can write.
  - View Logs/Executions in Apps Script editor for schema and insert error details.

**Notes & Best Practices**

- Do NOT commit any secret keys or service-account JSON files. Use Script Properties, Secret Manager, or a secure store.
- Use `apps-script/.claspignore` to ensure `node_modules` and local test helpers are not pushed to Apps Script.
- For large volumes consider using the GCS -> BigQuery load job pattern instead of streaming `insertAll` from Apps Script.

If you want, I can add a `README-BQ-DDL.md` with a BigQuery `CREATE TABLE` DDL that matches the importer schema.
