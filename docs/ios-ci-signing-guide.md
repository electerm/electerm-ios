# iOS CI Signing Guide — How to Obtain and Set Up Apple Signing Secrets

This guide walks you through obtaining every secret needed by
`.github/workflows/build-ios-release.yml` and setting them as GitHub
repository secrets. After completing this guide, pushing to the
`release-ios` branch (or triggering the workflow manually) will build
a signed IPA and upload it to App Store Connect automatically.

---

## Prerequisites

- An **Apple Developer Program** membership ($99/year, Organization or
  Individual). Sign up at <https://developer.apple.com/programs/>.
- Admin or App Manager role in **App Store Connect**.
- A Mac with **Keychain Access** and **Xcode** (for exporting the
  certificate locally; the CI build itself runs on GitHub's macOS
  runner, so you don't need Xcode after the one-time setup).

---

## Overview of Required Secrets

| Secret Name | What It Is | Required? |
|---|---|---|
| `IOS_CERTIFICATE_P12_BASE64` | iOS Distribution certificate (.p12), base64-encoded | ✅ Yes |
| `IOS_CERTIFICATE_PASSWORD` | Password you set when exporting the .p12 | ✅ Yes |
| `IOS_PROVISIONING_PROFILE_BASE64` | App Store provisioning profile (.mobileprovision), base64-encoded | ✅ Yes |
| `APPLE_ID` | Your Apple ID email (e.g. `zxdong@gmail.com`) | ✅ Yes |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for `altool` upload | ✅ Yes (or use API key) |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID | ✅ Yes |
| `SERVER_SECRET` | JWT secret for on-device electerm server | Optional |
| `APP_STORE_CONNECT_API_KEY_P8` | App Store Connect API key (.p8), base64-encoded | Optional (recommended) |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect API issuer ID | Optional (with API key) |
| `APP_STORE_CONNECT_KEY_ID` | App Store Connect API key ID | Optional (with API key) |

> **Two upload methods are supported.** You can use either:
> - **App-specific password** (simpler, but passwords can expire) — set
>   `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD`.
> - **App Store Connect API key** (recommended, doesn't expire, more
>   reliable) — set all three `APP_STORE_CONNECT_*` secrets.
>
> If both are set, the API key method is used. If only the password is
> set, that method is used.

---

## Step 1: Find Your Apple Team ID

Your **Team ID** is a 10-character string (e.g. `38ZYC7L6N5`) that
identifies your developer team.

1. Go to <https://developer.apple.com/account>.
2. Log in with your Apple ID.
3. Click **Membership** in the sidebar.
4. Look for **Team ID** — it's a 10-character alphanumeric string.

```bash
# Set it as a GitHub secret:
gh secret set APPLE_TEAM_ID --body "YOUR_TEAM_ID"
```

---

## Step 2: Register an App ID

An **App ID** maps your app's bundle identifier (`org.electerm.electerm-ios`)
to Apple's signing system.

1. Go to <https://developer.apple.com/account/resources/identifiers/list>.
2. Click the **+** button to create a new identifier.
3. Select **App IDs** → Continue.
4. Select **App** → Continue.
5. Fill in:
   - **Description**: `electerm iOS`
   - **Bundle ID**: select **Explicit**, enter `org.electerm.electerm-ios`
   - **Capabilities**: check any your app needs (the defaults are fine
     for electerm — no special entitlements are required beyond what
     Capacitor provides automatically).
6. Click **Continue** → **Register**.

> If an App ID with `org.electerm.electerm-ios` already exists, skip this
> step.

---

## Step 3: Create an iOS Distribution Certificate

This certificate allows Xcode/codesign to sign your app for App Store
distribution.

### Option A: Create via Developer Portal (recommended for CI)

1. On your Mac, open **Keychain Access**.
2. Menu: **Keychain Access → Certificate Assistant → Request a
   Certificate from a Certificate Authority…**
3. Fill in:
   - **User Email Address**: your Apple ID email
   - **Common Name**: `electerm iOS Distribution`
   - **CA Email**: leave blank
   - Choose **Saved to disk** → save the `.certSigningRequest` file.
4. Go to
   <https://developer.apple.com/account/resources/certificates/list>.
5. Click **+** → under **Software**, select **Apple Distribution**
   (or **iOS Distribution (App Store and Ad Hoc)** if you're on an
   older portal) → Continue.
6. Upload the `.certSigningRequest` file you saved in step 3.
7. Click **Generate** → **Download** the `.cer` file.

### Export the .p12 file

1. Double-click the downloaded `.cer` file — it opens in Keychain
   Access and installs under **My Certificates**.
2. In Keychain Access, find the certificate named **Apple Distribution:
   …** (or similar).
3. Click the **disclosure triangle** to expand it — you should see a
   **private key** underneath.
4. Select **both** the certificate **and** its private key
   (click the certificate, then shift-click the private key).
5. Right-click → **Export 2 items…**.
6. Save as `electerm-ios-distribution.p12`.
7. **Set a password** — this is your `IOS_CERTIFICATE_PASSWORD`. Remember
   it! You'll need it for the GitHub secret.
8. Click **OK**. Keychain Access may ask for your login password to
   allow the export.

### Convert to base64 and set as GitHub secret

```bash
# On your Mac:
base64 -i temp/electerm-ios-distribution.p12 | pbcopy

# The base64 string is now on your clipboard. Set it as a GitHub secret:
gh secret set IOS_CERTIFICATE_P12_BASE64 --body "$(pbpaste)"

# Set the password you chose during export:
gh secret set IOS_CERTIFICATE_PASSWORD --body "THE_PASSWORD_YOU_SET"
```

> **Tip**: if you don't have the `gh` CLI, you can set secrets via the
> GitHub web UI: **Repo → Settings → Secrets and variables → Actions →
> New repository secret**.

---

## Step 4: Create an App Store Provisioning Profile

A **provisioning profile** links your App ID, distribution certificate,
and App Store Connect. Without it, the app cannot be signed for App
Store distribution.

1. Go to
   <https://developer.apple.com/account/resources/profiles/list>.
2. Click **+** → under **Distribution**, select **App Store** →
   Continue.
3. Select the App ID you created in Step 2 (`org.electerm.electerm-ios`)
   → Continue.
4. Select the **Apple Distribution** certificate you created in Step 3
   → Continue.
5. **Profile Name**: `electerm-ios-appstore` (or any name you like —
   the CI workflow reads the profile name dynamically).
6. Click **Generate** → **Download** the `.mobileprovision` file.

### Convert to base64 and set as GitHub secret

```bash
# On your Mac:
base64 -i electerm-ios-appstore.mobileprovision | pbcopy

# Set as GitHub secret:
gh secret set IOS_PROVISIONING_PROFILE_BASE64 --body "$(pbpaste)"
```

---

## Step 5: Create the App in App Store Connect

Before you can upload a build, the app must exist in App Store Connect.

1. Go to <https://appstoreconnect.apple.com/apps>.
2. Click the **+** button → **New App**.
3. Fill in:
   - **Platforms**: iOS
   - **Name**: `electerm` (or your preferred display name)
   - **Primary Language**: English (U.S.)
   - **Bundle ID**: select `org.electerm.electerm-ios` (must match exactly)
   - **SKU**: `electerm-ios` (internal identifier, not shown to users)
   - **Full Access**: check if your account has full access
4. Click **Create**.

> The app doesn't need screenshots, pricing, or availability set up
> before uploading a build. You can upload first and fill in metadata
> later.

---

## Step 6: Set Up Upload Authentication

You need **one** of the two methods below for uploading to App Store
Connect. The API key method is recommended.

### Method A: App-Specific Password (simpler)

An **app-specific password** is required because your Apple ID has
two-factor authentication (2FA) enabled, and `altool` doesn't support
interactive 2FA.

1. Go to <https://appleid.apple.com>.
2. Sign in with your Apple ID.
3. Under **App-Specific Passwords**, click **Generate an app-specific
   password…** (or **Generate Password** under the Sign-In and Security
   section).
4. Name it: `electerm-ci-upload`.
5. Apple generates a password in the format `xxxx-xxxx-xxxx-xxxx`.
6. **Copy it immediately** — you won't see it again.

```bash
# Set GitHub secrets:
gh secret set APPLE_ID --body "zxdong@gmail.com"
gh secret set APPLE_APP_SPECIFIC_PASSWORD --body "xxxx-xxxx-xxxx-xxxx"
```

### Method B: App Store Connect API Key (recommended)

The API key doesn't expire (unless you revoke it) and is more reliable
for CI.

1. Go to <https://appstoreconnect.apple.com/access/integrations/api>.
2. Click **+ Create API Key** (or **Generate API Key**).
3. **Name**: `electerm-ci-upload`.
4. **Access Level**: **App Manager** (minimum) or **Admin**.
5. Click **Generate**.
6. You'll see three values:
   - **Issuer ID** — a UUID (e.g. `2f1c2a3b-…`)
   - **Key ID** — a 10-character string (e.g. `ABC123DEF4`)
   - **Download API Key** — a link to download the `.p8` file

7. **Download the `.p8` file** — you can only download it once!

```bash
# Convert the .p8 to base64 and set GitHub secrets:
base64 -i AuthKey_ABC123DEF4.p8 | pbcopy

gh secret set APP_STORE_CONNECT_API_KEY_P8 --body "$(pbpaste)"
gh secret set APP_STORE_CONNECT_ISSUER_ID --body "2f1c2a3b-..."
gh secret set APP_STORE_CONNECT_KEY_ID --body "ABC123DEF4"
```

> **Note**: The `.p8` file must be placed at
> `~/private_keys/AuthKey_KEY_ID.p8` for `altool` to find it. The CI
> workflow handles this automatically.

---

## Step 7 (Optional): Set SERVER_SECRET

The `SERVER_SECRET` is a JWT signing key baked into the app at build
time. It's used by the on-device electerm Node.js server to sign JWT
tokens for its own API. If not provided, the CI generates a random one
each build (which is fine — tokens don't persist across app launches).

For reproducible builds, set a fixed secret:

```bash
openssl rand -hex 32
# Copy the output and set it:
gh secret set SERVER_SECRET --body "the_hex_string_from_above"
```

---

## Complete Secret-Setting Commands (Copy & Paste)

```bash
# 1. Team ID
gh secret set APPLE_TEAM_ID --body "38ZYC7L6N5"

# 2. Distribution certificate (.p12 base64 + password)
base64 -i electerm-ios-distribution.p12 | pbcopy
gh secret set IOS_CERTIFICATE_P12_BASE64 --body "$(pbpaste)"
gh secret set IOS_CERTIFICATE_PASSWORD --body "YOUR_P12_PASSWORD"

# 3. Provisioning profile (base64)
base64 -i electerm-ios-appstore.mobileprovision | pbcopy
gh secret set IOS_PROVISIONING_PROFILE_BASE64 --body "$(pbpaste)"

# 4a. App-specific password (Method A)
gh secret set APPLE_ID --body "zxdong@gmail.com"
gh secret set APPLE_APP_SPECIFIC_PASSWORD --body "xxxx-xxxx-xxxx-xxxx"

# 4b. OR App Store Connect API key (Method B — recommended)
base64 -i AuthKey_ABC123DEF4.p8 | pbcopy
gh secret set APP_STORE_CONNECT_API_KEY_P8 --body "$(pbpaste)"
gh secret set APP_STORE_CONNECT_ISSUER_ID --body "2f1c2a3b-..."
gh secret set APP_STORE_CONNECT_KEY_ID --body "ABC123DEF4"

# 5. (Optional) Server secret
gh secret set SERVER_SECRET --body "$(openssl rand -hex 32)"
```

---

## How to Trigger the Build

### Option 1: Push to a branch

```bash
git checkout -b release-ios
git push origin release-ios
```

The workflow triggers on pushes to: `release`, `release-ios`,
`build-ios-release`.

### Option 2: Manual trigger

1. Go to your repo on GitHub.
2. **Actions** tab → select **build-ios-release** workflow.
3. Click **Run workflow** → choose the branch → **Run workflow**.

### Option 3: Trigger from another branch

Edit the workflow's `on.push.branches` list to add your branch name.

---

## What the Workflow Does (Step by Step)

```
1. Checkout code
2. Set up Node.js 24 + Xcode
3. npm i (install electerm + build tooling)
4. npm --prefix build/ios install (install Capacitor + nodejs plugin)
5. npm run build:ios (vite + esbuild → www/ bundle)
6. npx cap sync ios (copy web assets into native project)
7. Apply Info.plist ATS overlay (allow http://127.0.0.1)
8. Resolve SPM dependencies (@capawesome/capacitor-nodejs)
9. Create temporary keychain + import .p12 certificate
10. Install .mobileprovision provisioning profile
11. Update build number (CFBundleVersion = GitHub run number)
12. xcodebuild archive (signed Release build → .xcarchive)
13. Generate ExportOptions.plist + export IPA
14. Upload IPA to App Store Connect via altool
15. Upload IPA + xcarchive as workflow artifacts
16. Clean up temporary keychain
```

---

## Troubleshooting

### "❌ No IPA file was created"

Check `/tmp/xcodebuild-export.log` in the workflow logs. Common causes:
- Provisioning profile doesn't match the certificate.
- Provisioning profile is not an **App Store** type (must be
  Distribution → App Store, not Development or Ad Hoc).
- Bundle ID in the profile doesn't match `org.electerm.electerm-ios`.

### "Code Sign error: no matching provisioning profile found"

- The provisioning profile was not installed correctly. Check the
  "Install App Store provisioning profile" step output.
- The profile's App ID doesn't match the bundle ID.
- The profile was created with a different certificate than the one
  you imported.

### "altool: Error: The build number already exists"

Each upload to App Store Connect must have a **unique build number**
(`CFBundleVersion`). The workflow sets this to the GitHub Actions run
number automatically. If you re-run a failed workflow, the same run
number is used, which can cause this error.

**Fix**: Either:
- Trigger a new workflow run (new run number).
- Or delete the existing build in App Store Connect and re-run.

### "altool: Error: You are not allowed to perform this operation"

- Your Apple ID doesn't have **App Manager** or **Admin** role in
  App Store Connect.
- The app-specific password was revoked or expired.
- The API key was revoked.

### "Apple web service operation was not successful"

- The app doesn't exist yet in App Store Connect (Step 5).
- The bundle ID in the Xcode project doesn't match the App ID.

### Archive succeeds but export fails with signing errors

Make sure the `CODE_SIGN_STYLE` is set to `Manual` (the workflow does
this via `xcodebuild` flags). If the Xcode project has automatic
signing cached from a local build, it may conflict. The workflow
overrides this, but if it still fails, check the project file:

```bash
grep CODE_SIGN_STYLE build/ios/ios/App/App.xcodeproj/project.pbxproj
```

All entries should show `Automatic` (the workflow overrides at build
time).

---

## Architecture Notes

- **Bundle ID**: `org.electerm.electerm-ios` (set in
  `build/ios/ios/App/App.xcodeproj/project.pbxproj` and
  `build/ios/capacitor.config.ts`).
- **Deployment target**: iOS 15.0 (`IPHONEOS_DEPLOYMENT_TARGET = 15.0`).
- **Device family**: iPhone + iPad (`TARGETED_DEVICE_FAMILY = "1,2"`).
- **Signing identity**: `iPhone Distribution` (not `iPhone Developer`).
- **The IPA is a universal binary** — it runs on all iOS devices
  (arm64). Unlike macOS, iOS doesn't need separate x64/arm64 builds.
- **Upload tool**: `xcrun altool` (same as the Mac MAS workflow, but
  with `--type ios` instead of `--type macos`).

---

## Local Testing (Optional)

To test the signing setup locally before pushing to CI:

```bash
# 1. Build the web bundle
npm i
npm --prefix build/ios install
npm run build:ios
cd build/ios && npx cap sync ios && node build.mjs --overlay-only

# 2. Open in Xcode
cd build/ios && npx cap open ios

# 3. In Xcode:
#    - Select the "App" scheme
#    - Select "Any iOS Device (arm64)" as the destination
#    - Product → Archive
# 4. In the Organizer window:
#    - Select the archive → Distribute App → App Store Connect
```

This lets you verify that signing works before committing to CI.
