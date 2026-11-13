# LockIn offline APK

Offline focus timer (timer + goal modes, strikes, pause, hold-to-finish). Finished sessions are saved on the
phone and synced to your database whenever the phone is online.

## 1. Server (one time)
1. phpMyAdmin → run `server/migration.sql`.
2. Upload `server/session-sync.php` to `htdocs/api/` on your host.
3. Optional: add `'sync_key' => 'some-long-random-string',` to `config.php` and put the same value in `www/config.js`.
4. `www/config.js` → set `apiBase` to your site (already `https://lockin.xo.je`).

## 2. Build the APK
**GitHub (no installs):** push this folder to a GitHub repo → Actions → *Build APK* → Run workflow →
download `LockIn-apk` → unzip → install `app-debug.apk` (allow "install unknown apps").

**Locally** (Node 18+, JDK 17, Android SDK):
```
npm install
npx cap add android
npx cap sync android
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

## How offline/sync works
- Timer runs on-device; each finished session goes into a local queue (`localStorage`).
- Sync runs on app start, when the phone regains internet, every 60 s while sessions are waiting, and via "Sync now".
- Each session has a unique id, so retries never create duplicates. Streaks use the day the session ended.
- If the app is killed mid-session, it is recovered on next launch (counted up to the last saved moment).

## Not in the offline app
YouTube soundtrack, in-lock search, login/accounts, share cards and the live leaderboard (all need internet).
Synced sessions are stored without a user account (email hash only, as in the anonymous flow).

## If sync says "server did not return JSON"
InfinityFree's bot protection can answer app requests with an HTML challenge page. Sessions stay safely queued.
Fix: host `session-sync.php` (and a copy of the DB access) somewhere without that challenge, or use a paid plan.
"# timer" 
