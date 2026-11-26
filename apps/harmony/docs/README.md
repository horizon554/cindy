# Cindy 鸿蒙客户端技术方案

首版建议面向中国大陆的 HarmonyOS 5 / NEXT 及后续原生鸿蒙手机，使用 ArkTS、ArkUI 和 Stage 模型，在本仓独立构建、签名与发布。用户在手机登录 Cindy，选择自己的电脑，创建或继续任务，离开后仍能回来查看结果。最低支持系统、可连接的 Host 版本和发行范围需在真机验证后确定。[首版任务与里程碑](v1-milestones.md)

模拟器已验证附件收发、系统分享、离线语音转写和通知返回任务。各轮剩余依赖及验收条件见[跨阶段待办](v1-milestones.md#跨阶段待办)，推送错误码与投递证据见 [M3 验收记录](m3-validation.md)。

输入区、消息与审批、登录与列表三批的操作结果见 [UI 验收记录](ui-validation.md)。正式签名、Host 与系统版本、权限披露和商店材料见 [M4 发行准备](m4-readiness.md)。

## 选型依据

2026-11-26 检查的 Cindy 主仓基线为 `59d46dee61`。移动端使用 Expo SDK 58、RN 0.88.1 与 React 19.3.0，依赖 Expo Router、SecureStore、Notifications、Audio、Updates、Worklets 和 WebView 等。27 个本地模块目录中，Agent-Net 和远程凭证模块都只注册了 Apple 与 Android。首版可按用户路径裁剪模块，身份与传输仍需接入真实平台能力。[移动端依赖](../../mobile/package.json) · [Agent-Net 模块](../../mobile/modules/cindy-agent-net/expo-module.config.json) · [远程凭证模块](../../mobile/modules/cindy-remote-credentials/expo-module.config.json)

| 路线 | 可获得的收益 | 对 Cindy 的成本和适用条件 |
| --- | --- | --- |
| 原生 ArkUI，首版采用 | 生命周期、键盘、文件、通知和应用发布直接使用鸿蒙能力，升级可按鸿蒙系统要求排期 | 需要实现任务 UI 和同步层。新增卡片或修改流式行为时，三端用同一组脱敏消息和预期交互结果验收 |
| 独立 RNOH 应用 | 有机会直接复用 React 消息卡片、列表及 TS 业务逻辑 | 需要匹配 RN、渲染依赖和原生模块。若卡片同步交付成为主要成本，可用真实任务页、输入框与审批卡片对照验证复用量、流式体验和升级补丁 |
| 沿用现有 Expo 工程统一出包 | 同一应用入口、路由和依赖基线，页面改动可以三端同时交付 | 需要 Expo、RNOH、导航和动画同时兼容。遇到版本错位，三端需共同等待，或由团队维护框架补丁。鸿蒙签名与发布仍需独立配置 |

### 跨端方案的维护方与版本依据

RNOH 由鸿蒙侧 CPF-RN 社区维护，华为开发者文档列为跨平台方案，华为与 Software Mansion 参与开发。RNOH 按自己的节奏跟进 React Native 上游。Expo Harmony 则由 Baoshuo 与社区贡献者维护，在 RNOH 上提供 Expo 模块、自动链接、原生工程生成和 HAP 构建。采用 Expo 路线时，需要同时跟踪这两层的适配进度。[华为跨平台方案](https://developer.huawei.com/consumer/cn/doc/guidebook/solution-0000002784651007/) · [RNOH 合作方说明](https://account.swmansion.com/blog/huawei-x-software-mansion-bringing-react-native-support-to-harmonyos-next-82e02bd75549/) · [Expo Harmony 工程与维护者](https://github.com/renbaoshuo/expo-harmony/tree/af6f381bcceb)

截至 2026-11-26，Cindy 与 React Native 上游稳定版均为 RN 0.88.1。RNOH 的 npm 默认包 0.82.37 声明配套 RN 0.82.1，较新的预览渠道 0.86.1 配套 RN 0.86.3。另有源码适配仓报告基于 RN 0.88.0 构建 HAR 成功，公开 npm 发布记录中尚无配套 Cindy 0.88.1 的版本。Expo Harmony 的示例采用 Expo SDK 57、RN 0.86.3、RNOH 0.86.1。框架构建、依赖兼容和 Cindy 签名应用的真机结果需分别核对，本次仅核查源码和发布记录。[上游版本](https://reactnative.dev/versions) · [RNOH 发布记录](https://registry.npmjs.org/@react-native-oh/react-native-harmony) · [0.88 源码适配记录](https://gitcode.com/oh-react-native/ohos_react_native) · [Expo Harmony 示例基线](https://github.com/renbaoshuo/expo-harmony/blob/af6f381bcceb/docs/QuickStart.md)

### 对 Cindy 的实际影响与复评条件

- **最值得共享的是任务消息与交互。** 独立 RNOH 工程有机会直接使用消息渲染器、流式增量处理与审批组件，同时单独适配鸿蒙输入框。现有通用富文本输入依赖 WebView、Reanimated、文件系统与剪贴板，输入行还使用粘贴原生模块。即使只做文本任务，也要实测中文组合输入、键盘避让和长历史滚动。[消息渲染器](../../mobile/src/session/MessageRenderer.tsx) · [富文本输入](../../mobile/src/session/ComposerRichInput.tsx) · [输入行](../../mobile/src/session/MobileComposerInputRow.tsx)
- **Expo 模块的覆盖已有基础。** 按上述日期将 Cindy 的 33 个 Expo 系直接依赖与社区移植清单逐名比对，其中 29 个有对应条目。其余为 `@expo/ui`、`expo-apple-authentication`、`expo-glass-effect` 和 `expo-paste-input`。包名覆盖只能用于筛选待验证的模块。例如该版通知适配要求至少 API 23，若计划覆盖鸿蒙 5.x，仍需验证通知接入与整包的最低安装版本。[社区模块清单](https://github.com/renbaoshuo/expo-harmony/blob/af6f381bcceb/README.md) · [通知模块约束](https://github.com/renbaoshuo/expo-harmony/blob/af6f381bcceb/packages/expo-notifications/README.md)
- **直接共用 Expo 工程还会牵动已有两端。** Cindy 的 Metro 显式绑定 React 和 RN 的解析位置，推送注册含平台二选一，自建 OTA 插件只装配 iOS 与 Android。引入第三端时需要验证发布包实际加载的运行时、平台身份、更新渠道和已有两端指纹。设备身份、Agent-Net 原生桥和华为推送投递在两种跨端路线下都需要平台接线。[Metro 配置](../../mobile/metro.config.js) · [推送注册](../../mobile/src/notifications/pushNotifications.ts) · [OTA 插件](../../mobile/plugins/with-selfhost-ota.js) · [移动端冷更边界](../../../docs/dev-rules/mobile-development.md)

首版按原生路线进入 [M1a 模拟器启动，随后 M1b 真机建链](v1-milestones.md)。若后续卡片和任务页同步交付成为主要成本，优先复评独立 RNOH 构建。用同一份生产组件在签名鸿蒙包中走通真实 Host 的流式消息、审批和前后台恢复，记录长列表与输入体验，以及每次升级要维护的补丁。若共享可持续且平台差异集中在输入、网络等边界，可重新选择 RNOH。进一步合并 Expo 工程，则需在届时的 Cindy 依赖组合上完成一次三端共同升级，验证各端发布包、更新隔离与原生指纹。

## 哪些行为共用，哪些由鸿蒙实现

- **产品行为以当前主仓为准。** 对照移动端的真实任务入口、能力协商、审批、停止和恢复语义；Android 提供 CN 登录、系统返回、分享、权限拒绝后的交互参照。云端伙伴由 Chat 服务承载，后续接入时沿用其消息来源。[任务传输入口](../../mobile/src/device-link/mobileMakerTransport.ts) · [移动端场景测试](../../mobile/src/__tests__/mobileRemoteFlowSmoke.test.ts) · [云端伙伴](../../mobile/src/chat/cloudCompanion.ts)
- **职责划分参考原生 iOS。** 独立 UIKit 工程在基线 `3a2475f` 已拆分 Domain、Protocol、Persistence、Sync、DeviceLink、Presentation、AppShell。鸿蒙首版按这些职责组织一个应用，页面订阅状态，应用层持有账号与连接生命周期。
- **复用契约与内核。** 三端共享脱敏的消息样本、事件顺序和预期结果，覆盖未知消息、重复增量、撤权和迟到响应。对无平台依赖的 TS 逐项检查 ArkTS 兼容性；Agent-Net 优先验证 Rust core 经现有 C ABI 接入鸿蒙 Node-API。[Device Link](../../../packages/device-link/src) · [Rust 依赖](../../../packages/agent-net-native/Cargo.toml) · [C ABI](../../../packages/agent-net-native/include/cindy_agent_net.h) · [华为 Native Module](https://developer.huawei.com/consumer/cn/doc/guidebook/programming-language1-0000002593254720/)

| 鸿蒙职责 | 建议实现与状态归属 |
| --- | --- |
| 应用入口与 UI | UIAbility 处理冷启动、前后台、登录回调与通知入口，ArkUI Navigation 管理导航。按消息类型渲染文本、工具、审批和附件。用真机检查长列表滚动、中文输入和键盘避让。[Stage 模型](https://developer.huawei.com/consumer/cn/arkui/arkui-stage) |
| 网络与同步 | 使用系统 HTTPS、WebSocket，沿用 Host 支持的 Device Link 与 Agent-Net 协商。远程任务的权威状态归执行 Host；重连补订阅、补历史，对已接受的写操作去重。[传输协商](../../mobile/src/device-link/agentNetMode.ts) |
| 本地数据 | ArkData 关系库保存摘要、消息、游标与草稿；按账号、设备、任务隔离。短敏感凭证存 Asset Store Kit，切换账号后丢弃旧代次响应。[ArkData](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/data-mgmt-overview/) · [Asset Store Kit](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/asset-store-kit-overview) |
| 通知与恢复 | 前台订阅，后台由 Push Kit 提醒，点击后重新校验目标与权限并补齐历史。按系统后台任务约束设计，普通任务提醒无需长期驻留。[Push Kit](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-guides/push-gettingstart/) · [后台长时任务](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/continuous-task/) |

## 影响首版范围的两项兼容问题

1. 共享设备分类当前只识别 ios、android。旧客户端可能把新平台值当成候选电脑。开发前要核对设备字段的发布端、消费端和仍在使用的旧客户端，以新旧互见结果确定支持范围。[设备分类](../../../packages/maker-shared/src/deviceList.ts) · [云端伙伴选择电脑](../../mobile/src/chat/cloudCompanion.ts)
2. 已检查的移动推送注册模型只表达 APNs、FCM。华为通知需要 AppGallery Connect 权益、客户端 token 和服务端实际投递。现网华为通道状态尚待核实；如需扩充服务端契约，单列协作任务，保留已发布客户端的注册行为。[推送注册模型](../../mobile/src/notifications/pushRegistrationModel.ts) · [华为 token 与权益](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-guides/push-get-token/)
