curl --location --request PUT 'http://103.17.178.73:8080/zstack/v1/billings/accounts/36c27e8ff05c4780bf6d2fa65700f22e/actions' \
--header 'Authorization: OAuth 9651c85c3bdc4c1aaeb86d77a4161c40' \
--header 'Content-Type: application/json' \
--header 'Cookie: JSESSIONID=6587B77076E7471D823082DABD78F5C1' \
--data '{
"calculateAccountSpending": {
"dateStart": 1763164800000,
"dateEnd": 1763251199000
},
"systemTags": [],
"userTags": []
}
'
