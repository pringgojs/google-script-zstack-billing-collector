#!/bin/bash

usernya="admin"
passwordplain='M9Me4LHg$JWHS#5KLX'
#usernya="subakun"
#passwordplain='zstack'
# kalo versi CLI (python-based) ternyata password harus dihash sha512sum dan dihexdigest
# msg.password = hashlib.sha512(msg.password).hexdigest()
passwordnya=$(echo -n "${passwordplain}" | sha512sum | cut -d' ' -f1)

response=$(curl -sk --digest -X PUT "http://localhost:8080/zstack/v1/accounts/login" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "logInByAccount": {
    "accountName": "${usernya}",
    "password": "${passwordnya}"
  }
}
EOF
)

echo "$response"

uuid=$(echo "$response" | grep -o '"uuid"[[:space:]]:[[:space:]]"[^"]"' | head -1 | sed 's/."\([^"]\)"./\1/')

echo "UUID: $uuid" 