<h1 align="center" style="padding-top: 60px;padding-bottom: 40px;">
  <a href="https://electerm.org">
    <img src="https://github.com/electerm/electerm-resource/raw/master/static/images/electerm.png" alt="electerm" />
  </a>
</h1>

[![GitHub version](https://badgers.space/github/release/electerm/electerm-ios?corner_radius=m)](https://github.com/electerm/electerm-ios/releases)
[![Build Status](https://github.com/electerm/electerm-ios/actions/workflows/build-ios.yml/badge.svg)](https://github.com/electerm/electerm-ios/actions)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/electerm/electerm-ios/blob/main/LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/electerm?label=Sponsors)](https://github.com/sponsors/electerm)
[![English](https://img.shields.io/badge/English-EN-blue)](README.md)
[![中文](https://img.shields.io/badge/中文-Chinese-blue)](README_cn.md)

开源的 iOS 端 ssh/sftp/telnet/RDP/VNC/Spice/ftp 客户端，基于
[electerm-web](https://github.com/electerm/electerm-web) 代码库，使用
[Capacitor](https://capacitorjs.com/) 和设备端 Node.js 运行时构建。

> **关于本地终端和串口的说明：** electerm iOS 版目前**不支持**本地终端和串口。
> 这些功能依赖于原生库（`node-pty`、`serialport`），目前无法为 iOS 编译。
> 未来在原生依赖移植完成后有潜力添加这些功能。SSH、SFTP、Telnet、FTP、RDP、VNC
> 和 Spice 均可正常使用，因为它们是纯 JS / WASM 实现的网络协议。

- [electerm.org](https://electerm.org): 主页，下载，视频等
- [electerm-web](https://github.com/electerm/electerm-web): 运行于浏览器(支持移动设备)的web app版本
- [electerm-web-docker](https://github.com/electerm/electerm-web-docker): electerm-web的docker镜像
- [electerm online](https://cloud.electerm.org): 公共免费在线electerm应用
- [electerm demo](https://demo.electerm.org): 在线演示
- [electerm AI](https://ai.electerm.org): 免费为 electerm 用户提供 AI
- [electerm theme](https://theme.electerm.org): 创建/分享主题站点，支持实时预览与 AI 创建
- [electerm deb repo](https://repos.electerm.org/deb): Debian repo of electerm
- [electerm rpm repo](https://repos.electerm.org/rpm): RPM repo of electerm
- [electerm Harmony](https://github.com/electerm/electerm-harmony): electerm for HarmonyOS (available on [Huawei AppGallery](https://appgallery.huawei.com/app/detail?id=org.electerm.electerm))

## 工作原理

```
WebView (前端)  ── http://127.0.0.1:5577 ──►  Node.js 后端 (设备端)
   加载 index.html                                提供 UI + SSH/SFTP/...
   (本地 "loading" 页面)                          API/WebSocket 同源
```

- **Capacitor** 提供原生 iOS 外壳 + WebView。
- **`@capawesome/capacitor-nodejs`** 内嵌 Node.js 运行时，应用启动时自动启动
  electerm 后端。
- electerm **前端** (React) 在 WebView 中渲染；electerm **后端** (Node.js 服务器，
  负责处理 SSH/SFTP/Telnet/FTP/RDP/VNC/Spice) 直接在设备上运行。

## 功能特性

- 🖥️ SSH / SSH 隧道 (代理) / SFTP / FTP / FTPS
- 🐚 Telnet
- 🖥️ 远程桌面: RDP / VNC / Spice
- 🔁 Zmodem (rz/sz), trzsz 文件传输
- 🌐 多语言、主题、书签、同步
- ❌ 本地终端 — **不可用** (原生 `node-pty` 目前无法为 iOS 编译)
- ❌ 串口 — **不可用** (原生 `serialport` 目前无法为 iOS 编译)

> 未来在所需原生库移植到 iOS 后，可能会添加本地终端和串口支持。

## 安装

electerm for iOS 基于 Capacitor 与设备端 Node.js 运行时构建。在实体设备上安装
需要已签名的构建 (通过 Xcode 或分发证书)。开发方式：

1. 本地构建应用 (见下方**开发**)，在 iOS 模拟器中运行，或从 Xcode 部署到设备。
2. 打开 electerm，稍等片刻让引擎启动，然后连接到你的主机。

> 持续构建会在每次推送到 `dev`/`main` 时产出未签名的 `.app` 作为 CI 产物。
> 若要生成已签名的 IPA，需要把你的 Apple 签名证书与描述文件加入仓库 secrets。

## 升级

使用最新源码重新构建，并通过 Xcode / 你的分发渠道重新安装。

## 已知问题

- 本地终端和串口在 iOS 上已禁用 (见上方说明)。

## 项目结构

```
src/                 electerm-web 源码 (前端 + Node.js 后端)
build/vite/          web 构建配置
build/ios/           iOS 构建脚本、Capacitor 项目、原生资源
  build.mjs          构建 www/ (前端 + 打包后的后端)
  capacitor.config.ts
  ios/               原生项目 (由 `cap add ios` 生成)
.github/workflows/   在 macOS 上构建 iOS 应用的 CI
```

本地构建和测试请参阅 [build/ios/README.md](build/ios/README.md)。

## 开发

```bash
# 需要 Node.js 24.x 与 Xcode 16+ (含 iOS SDK + 命令行工具)
npm config set legacy-peer-deps true
npm i
npm --prefix build/ios install

# 构建 web 前端 + Node.js 后端打包到 build/ios/www
npm run build:ios

# 创建原生项目 + 同步资源/插件 (仅首次)
cd build/ios
npx cap add ios
npx cap sync ios

# 在 Xcode 中打开并运行于模拟器 / 设备
npx cap open ios
```

未签名的应用会构建到 Xcode 的 DerivedData 中；打开
`build/ios/ios/App.xcworkspace` 即可运行。

## 赞助项目

github sponsor

[https://github.com/sponsors/electerm](https://github.com/sponsors/electerm)

kofi

[https://ko-fi.com/zhaoxudong](https://ko-fi.com/zhaoxudong)

微信赞赏码

[![wechat donate](https://electerm.org/electerm-wechat-donate.png)](https://github.com/electerm)

TRON TRN20

[![TRN20 donate](https://github.com/electerm/electerm-resource/blob/master/static/images/trn20.png?raw=true)]

地址: TXk3pQNmQu1vihH76RaEFnK9wg13x4LLCZ

## 联系作者

[zxdong@gmail.com](mailto:zxdong@gmail.com)

## 许可证

MIT
