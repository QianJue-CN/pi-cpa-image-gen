# Pi CPA Image Generator

一个 Pi 扩展：通过配置的 CPA / OpenAI-compatible Images API 生成图片，并保存到当前项目的 `.pi/generated-images/`。

## 安装

仓库公开后，在终端运行：

```sh
pi install git:github.com/QianJue-CN/pi-cpa-image-gen
```

之后可以直接描述要生成的图片，也可以使用 `/cpa-image <提示词>`。卸载：

```sh
pi remove git:github.com/QianJue-CN/pi-cpa-image-gen
```

## 配置

扩展会依次使用 `PI_CPA_API_KEY` / `OPENAI_API_KEY` 或 Pi provider 凭据；API 地址可以通过 `PI_CPA_BASE_URL` / `OPENAI_BASE_URL` 设置。默认读取 Pi provider `qianjue`，也可以设置 `PI_CPA_PROVIDER` 指定自己的 provider ID。

PowerShell 示例：

```powershell
$env:PI_CPA_API_KEY = "你的 API Key"
$env:PI_CPA_BASE_URL = "https://你的代理地址/v1"
$env:PI_CPA_PROVIDER = "你的 Pi provider ID"
```

`PI_CPA_ACTOR_AUTHORIZATION` 可覆盖默认的 `local-proxy` 请求头；设为空值可不发送该请求头。

## Pi 包协议

此仓库包含 Pi package manifest（`package.json` 中的 `pi.extensions`）及 `pi-package` 关键词，可直接通过 Pi 的 Git package source 安装。运行扩展需要信任代码，并配置可用的 Images API 凭据。
