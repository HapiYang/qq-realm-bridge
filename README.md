# QQ群 ↔ Minecraft Realm 聊天桥

把 QQ 群和 Minecraft **基岩版 Realm** 打通：群里说话游戏里能看到，游戏里说话群里能看到，另外还有玩家上下线提醒和在线名单查询。

只支持 Realm / 基岩版服务器，不开源服务端插件（原因见下）。

```
QQ群 ←OneBot v11 WS→ NapCat ←WS→ bridge(index.js) ←Bedrock 协议→ Realm
```

## 为什么必须这么绕

Realms 的自定义脚本**没有任何网络能力** —— `@minecraft/server-net` 只在 BDS（专用服务端）存在，Realm 上拿不到。所以「游戏 → QQ」只能派一个真的假人客户端进 Realm，从协议层收发聊天包。

代价：这个假人会占掉 Realm 10 人名额里的 1 个。

想彻底没这个麻烦就自建 BDS，用插件直接 POST 给桥接，不占名额、不怕协议更新。

## 功能

| 功能 | 说明 |
| --- | --- |
| 群 → 游戏 | 群里发的话以 `昵称: 内容` 注入游戏聊天栏 |
| 游戏 → 群 | 游戏聊天以 `[服务器名] <玩家> 内容` 发到群里 |
| 上下线提醒 | 玩家进出服时群里提示 `🟢 某某 上线了（在线 3 人）` |
| 在线玩家 | 群里发「在线」直接回在线名单 |
| 回声抑制 | 自己注入的话被读回来 8 秒内丢弃，不会在群里死循环 |
| 限流 | 游戏侧 1.5 秒 1 条，防止 QQ 群的节奏刷爆游戏聊天栏 |
| 自动重连 | QQ 侧 5s→30s 退避，MC 侧 3s→60s 退避 |

### QQ 指令

群里发下面任意一个，机器人回在线名单：

```
在线    在线玩家    谁在线    人数    玩家列表    list
#在线   !在线       /在线
```

## 快速开始

前提：Linux（Debian/Ubuntu 系）、node 18+、docker。

```bash
# 1. 装依赖
cd bridge && npm install --ignore-scripts && cd ..

# 2. 填配置
cp bridge/config.example.json bridge/config.json
$EDITOR bridge/config.json      # 填 qq.group 和 realm.invite
```

`realm.invite` 是 Realm 设置里的邀请链接 `https://realms.gg/xxxxxxxx`。
多个 Realm 时配合 `realm.pickRealm` 按名字挑。

`bot.gamertag` 也要填：Realms 里显示的是微软账号的 **Xbox 名**，不是
`bot.username` 那个"请求用的名字"。不填的话机器人会把自己算进在线名单，
自己说的话也可能被当成玩家消息转回群里。填法：

```json
"bot": { "username": "皮皮欢乐多Bot", "gamertag": "你的Xbox名", ... }
```

进游戏后看屏幕提示 / 或在群里发一次「在线」，对一下名单里有没有机器人自己。

```bash
# 3. 起 NapCat 并扫码
docker compose up -d
docker logs -f napcat           # 终端打出二维码字符画，手机 QQ 扫

# 4. 接通 OneBot（关键：必须是反向 WS，见「坑 2」）
cp napcat-config/onebot11.example.json napcat/config/onebot11_<你的QQ号>.json
docker restart napcat

# 5. 起桥接
./1-启动.sh
```

首次启动会打印：

```
================ 需要登录微软账号 ================
 打开 https://www.microsoft.com/link  输入代码: XXXXXXXX
```

用**已加入 Realm 的那个微软账号**登录，token 缓存在 `bridge/auth/`，之后自动复用。

看到下面三行就算成功：

```
[QQ] OneBot 已连接
[MC] 已进入 Realm
[MC] 在线名单已同步: 3 人
```

常驻：

```bash
./3-装成服务.sh                          # systemd，开机自启 + 崩溃重拉
sudo docker update --restart=always napcat
journalctl -u qq-realm-bridge -f
```

## 坑（都是实测踩出来的）

**1. `text` 包缺字段会踢人**

Bedrock 1.26 的 `text` 包新增了 `category` 和 `has_filtered_message`。少任何一个，服务器按错位字节解析，进游戏后**发第一条消息就掉线**（不报错、不提示，就是静默断开）。正确字段：

```js
mc.queue('text', {
  needs_translation: false,
  category: 'authored',
  type: 'chat',
  source_name: username,
  message: line,
  parameters: [],
  xuid: '',
  platform_chat_id: '',
  has_filtered_message: false,
  filtered_message: ''
})
```

**2. OneBot 必须是反向 WebSocket（服务端方向）**

bridge 是 WS **客户端**（`new WebSocket(url)`），所以 NapCat 要配在 `websocketServers` 里，监听容器内 `3001`，宿主机映射到 `3002`。配成 `websocketClients` 会发现两边都在等对方连接。

**3. `messagePostFormat` 用 `array` 就得自己摊平**

NapCat 开 `array` 后 `evt.message` 是分段数组，直接 `String()` 会得到 `[object Object]`。必须按 `type` 摊平（text / at / image / face）。

**4. Realm 走的是 nethernet，不是 raknet**

`/worlds/{id}/join` 返回 `networkProtocol: NETHERNET_JSONRPC` 时，bedrock-protocol 会自己切到 nethernet 传输。不用装 `raknet-native`（那个要 g++/cmake），本项目已指定纯 JS 的 `jsp-raknet` 后端。

**5. 在线名单包在 spawn 之前就发完了**

`player_list` 通常在进服瞬间整份下发，那时还没 spawn。直接按「有 add 就播上线」会一次刷一屏。做法：进服时静默同步，5 秒后才把后续变化当成真正的上下线。

**6. 名字带颜色码**

基岩版玩家名会带 `§a` `§r` 之类的格式化码，转发前要 `replace(/§./g, '')`，不然群里显示 `LengBaiKai§r`。

**7. Realms 永远跑最新正式版**

bedrock-protocol 是社区跟版本适配的。游戏大更新后如果报版本不支持：

```bash
cd bridge && npm i bedrock-protocol@latest --ignore-scripts
```

`--ignore-scripts` 别漏，否则会尝试编译 raknet-native。

**8. 进服前失败不会重连（已修）**

`mc.on('close')` 里原来有 `if (!mcReady) return;` —— 只在"进过游戏后断线"才重试。
如果登录阶段就失败（Realms 返回 503、账号被封、握手被拒），桥接会**永久卡死**，
日志停在一条错误上再也不动。现在进没进过服都会按退避重连。

**9. 中文在游戏里显示成 ####**

`text` 包的 `type` 只有 `chat` 会被 Realm 转发，但 `chat` 属于"玩家发言"，
会走平台的文本过滤，中文/@数字常被整段替换成 `#`。两条看起来可行的路实测都不行：

| 尝试 | 结果 |
| --- | --- |
| `type: 'raw'` | 服务端**不转发**，游戏里什么都看不到 |
| `has_filtered_message: true` + `filtered_message` 填正文 | 服务端判非法包，**静默踢人**（踢人提示为空） |
| `has_filtered_message: false` + `filtered_message: ''` | 能发，但中文被打成 `####` |

所以要解决只能从过滤源头下手：关掉世界的「文本过滤」，或检查机器人那个微软账号
是不是未成年账号（未成年人账号会被强制过滤）。协议层没有别的招。

## 目录

```
bridge/index.js              桥接主程序（全部逻辑都在这一个文件）
bridge/config.example.json   配置模板，复制成 config.json 再填
docker-compose.yml           NapCat 容器，端口 3002(WS)/3010(HTTP)/6099(WebUI)
napcat-config/               NapCat 的 OneBot 反向 WS 模板
1-启动.sh                    一键起 NapCat + 桥接（前台，方便看日志）
2-填配置.sh                  编辑 config.json
3-装成服务.sh                systemd 开机自启
```

运行时才会有的东西（已在 .gitignore）：

```
bridge/config.json           你的 Realm 邀请链接、群号、机器人 QQ 号
bridge/auth/                 微软 token，等于账号凭据，绝不能提交
napcat/                      QQ 登录数据和缓存
```

## 限制

- 假人占 1 个 Realm 名额
- 一次只能桥接一个群 + 一个 Realm
- 只转发文字，图片/表情/@ 会被剥成 `[图片]` `[表情]` 纯文本
- 协议跟版本强绑定，大版本更新可能要等依赖适配

## License

MIT
