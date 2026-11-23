# Canopy Mobile (React Native + Expo SDK 52)

Native mobile client for **Canopy** — peer-blind multi-pod rooms with **1 Pod Group Chat + 1:1 Private Member DMs**, `/poll` cards, `expo-av` Voice Notes, shared Pod Audio Calls, and MySQL `FULLTEXT` search.

## Tech Stack
- **Expo SDK 52** (`react-native` `0.76.7`, `react` `18.3.1`, TypeScript `strict: true`)
- **State & Caching**: `jotai` + `@tanstack/react-query` (zero Redux)
- **Realtime & Audio**: Native `WebSocket` (`/ws/pods/{podId}?token=...`) + `expo-av`
- **Design System**: Canopy `white-mint-tiles` (`#191b19`, `#f5f6f5`, `#ffffff`, `#232323`, `#a1ffcb`, `#1f6b3a`, zero violet, `>=44pt` touch targets)

## Prerequisites
Ensure the Canopy Spring Boot backend (`:8090`) and MySQL (`:3308`) are running from the repo root.

- **Android Emulator** defaults automatically to `http://10.0.2.2:8090` (host loopback).
- **iOS Simulator & Web** default automatically to `http://localhost:8090`.
- **Physical Wi-Fi Phones (Expo Go)**: Open the collapsible **Server URL** panel on the Sign-In or Account tab and enter your computer's LAN IP (e.g. `http://192.168.1.42:8090`), or pass `EXPO_PUBLIC_API_URL=http://192.168.1.42:8090`.

## Running the App

```bash
cd mobile
npm install --no-audit --no-fund --legacy-peer-deps
```

### 1. Expo Go (QR Code on Physical iOS / Android Phone)
```bash
npx expo start
```
Scan the terminal QR code with **Expo Go** (Android) or the **Camera** app (iOS). Set **Server URL** on the Sign-In screen to `http://<your-lan-ip>:8090`.

### 2. Android Emulator
```bash
npx expo start --android
```

### 3. iOS Simulator (macOS)
```bash
npx expo start --ios
```

### 4. Web Preview (Metro Bundler)
```bash
npx expo start --web --port 8081
```
*(If testing web preview against local Spring Boot `:8090`, include `http://localhost:8081` in `canopy.cors-origins` / `CORS_ORIGINS`.)*

## Verification Commands

```bash
# Strict TypeScript check
npx tsc --noEmit

# Production Metro web bundle verification
npx expo export --platform web --output-dir dist-web

# Non-trivial parser & zero-violet palette self-check
node scripts/selfcheck.mjs
```
