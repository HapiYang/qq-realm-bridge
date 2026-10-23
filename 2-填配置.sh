#!/usr/bin/env bash
cd "$(dirname "$0")"
${EDITOR:-nano} bridge/config.json
echo
echo "记得改：qq.group（群号） / realm.invite（https://realms.gg/xxxx）"
