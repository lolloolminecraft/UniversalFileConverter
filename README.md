# Universal File Converter

A Chrome Manifest V3 extension that provides one interface for converting files through multiple online conversion APIs.

The extension does **not** bundle shared API credentials and does **not** require Native Messaging, FFmpeg, ImageMagick, .NET, Python, DLLs, EXEs, or any other local helper software.

> **Privacy notice:** online conversion uploads the selected source file directly to the third-party provider chosen by the extension. Users can disable online conversion in **Settings → Privacy**.

## Highlights

- Multi-provider conversion with automatic failover
- User-supplied API keys only
- Dynamic `source → target` capability checks
- Multiple-file queue
- Automatic result download
- Provider health tracking and cooldowns
- Resumable async jobs when the provider supports them
- 356 format metadata entries across 19 specialized groups plus the general **Other** category
- Appearance controls: theme, accent, button color, background and corner radius
- No custom backend

## Providers

Universal File Converter currently integrates:

| Provider | Main use | Authentication | Capability discovery |
| --- | --- | --- | --- |
| ConvertAPI | General-purpose conversion | User API token | Dynamic converter info API |
| CloudConvert | General-purpose conversion | User API key | `/v2/operations` |
| FreeConvert | General-purpose conversion | User API key | Format query endpoints |
| Convert3D | 3D and CAD | User API token | Official documented format matrix |

Provider plans, limits and supported pairs can change. The extension therefore checks concrete conversion capabilities instead of assuming that every registered format can be converted to every other format.

## Automatic failover

For each conversion, Provider Manager builds an ordered list of compatible enabled providers.

If the first provider fails, the extension attempts the next provider that supports the same `source → target` pair.

Provider health is tracked across the queue:

- authentication failures can place a provider in a long cooldown;
- quota/permission failures can place a provider in a long cooldown;
- rate limits use an increasing cooldown;
- network, timeout and server-side failures use a shorter cooldown;
- pair-specific conversion errors fall through to the next compatible provider without globally disabling the provider.

A changed API key or a successful provider check clears the cooldown.

Because failover can retry a conversion through another service, the same source file may be uploaded to more than one third-party provider if an earlier attempt fails.

## Supported format registry

The registry contains metadata for 356 unique extensions covering categories such as:

- Images and RAW camera formats
- Vector graphics
- Video and audio
- Documents and PDF
- Spreadsheets and presentations
- Ebooks
- Archives
- Fonts
- Subtitles
- 3D and CAD
- Data and markup
- Disk images
- Scientific and technical formats

Registry presence does **not** mean a conversion pair is automatically supported. Availability is determined for the exact `source → target` pair.

## Installation

### Option 1 — GitHub Release

1. Download the latest ZIP from the **Releases** page.
2. Extract the archive.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted `UniversalFileConverter` folder.

### Option 2 — Source checkout

Clone or download this repository and load the repository folder as an unpacked extension in Chrome.

## Configure API keys

Open:

**Universal File Converter → Settings → API Providers**

Add at least one provider key and click **Check**.

Official key pages:

- ConvertAPI: https://www.convertapi.com/a/authentication
- CloudConvert: https://cloudconvert.com/dashboard/api/v2/keys
- FreeConvert: https://www.freeconvert.com/account/api-tokens
- Convert3D: https://convert3d.org/convert3dapi

For ConvertAPI, use a regular API token rather than a master token. For CloudConvert, the key should include the task permissions required by the conversion workflow.

## Privacy and API key storage

Files are sent directly from the extension to the selected provider. Universal File Converter does not operate its own file-processing backend.

API keys are stored in Chrome extension local storage. That is local application storage, not a cryptographic secret vault. Use dedicated tokens with the smallest practical permissions and provider-side usage/spending limits.

The public build contains no bundled provider credentials.

## Permissions

The extension requests only permissions used by the current architecture:

- `storage` — settings, provider configuration and queue metadata
- `downloads` — automatic result downloads
- `alarms` — continuation of asynchronous work when the MV3 service worker is suspended
- `unlimitedStorage` — temporary IndexedDB storage for selected files while they are waiting to upload

Host permissions are limited to the implemented provider API/upload domains.

## Project architecture

```text
Chrome Extension (Manifest V3)
        ↓
Service Worker
        ↓
Provider Manager
        ↓
Capability check + provider selection
        ↓
ConvertAPI / CloudConvert / FreeConvert / Convert3D
        ↓
Result URL / result file
        ↓
chrome.downloads
```

Important files:

```text
background/service-worker.js
core/format-registry.js
core/provider-manager.js
core/settings.js
providers/convertapi.js
providers/cloudconvert.js
providers/freeconvert.js
providers/convert3d.js
popup/popup.html
popup/popup.css
popup/popup.js
```

## Version

Current public release: **3.2.0**

The extension keeps the fixed unpacked-extension key used by this project. Current extension ID:

`jljjpgacpkhedfcpcnhnkglpnncfgnkk`

## Security

Do not commit personal or shared provider API keys to this repository. The public build intentionally ships with an empty bundled-credentials object.

If you discover a security issue, avoid posting credentials or sensitive files in a public GitHub issue.

## License

This project is released under the MIT License. See `LICENSE` in the repository.
