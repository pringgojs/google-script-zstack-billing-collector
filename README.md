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

---

http://103.17.178.73:22333/zstack/v1/accounts/login
Response:
{
"inventory": {
"uuid": "43dab049f43e429ba927e652d55b0840",
"accountUuid": "36c27e8ff05c4780bf6d2fa65700f22e",
"userUuid": "36c27e8ff05c4780bf6d2fa65700f22e",
"expiredDate": "Nov 25, 2025 10:15:10 AM",
"createDate": "Nov 25, 2025 8:15:10 AM",
"noSessionEvaluation": false
}
}
