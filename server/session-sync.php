<?php
/**
 * api/session-sync.php — POST. Batch-imports sessions that were finished
 * OFFLINE in the LockIn APK. Idempotent: each session carries a client_uuid,
 * so retrying a batch never creates duplicates.
 * Body: {sessions:[{client_uuid, started_at(ms), finished_at(ms), duration_sec,
 *        completed_sec, strikes, gave_up, name?, anonymous?, email?, email_hash?}]}
 * Upload to htdocs/api/ and run server/migration.sql once.
 */
declare(strict_types=1);

/* CORS for the Capacitor WebView (only needed if native HTTP is turned off). */
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ['https://localhost', 'http://localhost', 'capacitor://localhost'], true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Lockin-Key');
    header('Access-Control-Max-Age: 86400');
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }

require __DIR__ . '/bootstrap.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    json_fail('POST only.', 405, 'method');
}

global $CONFIG;
// Optional shared key (set 'sync_key' in config.php and in www/config.js).
// It ships inside the APK, so it only deters casual abuse.
$key = (string)($CONFIG['sync_key'] ?? '');
if ($key !== '' && !hash_equals($key, (string)($_SERVER['HTTP_X_LOCKIN_KEY'] ?? ''))) {
    json_fail('Not allowed.', 403, 'forbidden');
}
rate_limit('session-sync', 30, 3600);

$in   = post_json();
$list = $in['sessions'] ?? null;
if (!is_array($list) || count($list) < 1 || count($list) > 25) {
    json_fail('Send between 1 and 25 sessions.');
}
usort($list, function ($a, $b) {
    return (int)($a['finished_at'] ?? 0) <=> (int)($b['finished_at'] ?? 0); // oldest first → streaks stay in order
});

$tz = new DateTimeZone((string)($CONFIG['app_timezone'] ?? 'UTC'));
function local_dt(int $sec, DateTimeZone $tz): DateTimeImmutable {
    return (new DateTimeImmutable('@' . $sec))->setTimezone($tz);
}
function streak_for(?string $hash): array {
    if ($hash === null) { return [0, 0]; }
    $st = db()->prepare('SELECT current_streak, best_streak FROM streaks WHERE email_hash = ?');
    $st->execute([$hash]);
    $r = $st->fetch();
    return [(int)($r['current_streak'] ?? 0), (int)($r['best_streak'] ?? 0)];
}

$results = [];
foreach ($list as $s) {
    $uuid = is_array($s) ? (string)($s['client_uuid'] ?? '') : '';
    $out  = ['client_uuid' => $uuid, 'status' => 'rejected'];
    try {
        if (!preg_match('/^[A-Za-z0-9-]{16,64}$/', $uuid)) { $out['message'] = 'bad id'; $results[] = $out; continue; }

        // Already imported? → report success so the app clears its queue.
        $dup = db()->prepare('SELECT public_id, email_hash FROM sessions WHERE client_uuid = ?');
        $dup->execute([$uuid]);
        if ($row = $dup->fetch()) {
            [$cur, $best] = streak_for($row['email_hash']);
            $results[] = ['client_uuid' => $uuid, 'status' => 'duplicate', 'public_id' => $row['public_id'],
                          'streak_current' => $cur, 'streak_best' => $best];
            continue;
        }

        $duration = (int)($s['duration_sec'] ?? 0);
        $isFree   = ($duration === 43200);
        if (!$isFree && ($duration < 60 || $duration > 14400)) { $out['message'] = 'bad duration'; $results[] = $out; continue; }

        $startSec = intdiv((int)($s['started_at'] ?? 0), 1000);
        $endSec   = intdiv((int)($s['finished_at'] ?? 0), 1000);
        if ($startSec <= 0 || $endSec < $startSec || $endSec > time() + 300 || $startSec < time() - 60 * 86400) {
            $out['message'] = 'bad timestamps'; $results[] = $out; continue;
        }

        // Focused time can't exceed the session's wall-clock time or its planned length.
        $completed = max(0, min($duration, (int)($s['completed_sec'] ?? 0), $endSec - $startSec + 10));
        $strikes   = max(0, min(50, (int)($s['strikes'] ?? 0)));
        $gaveUp    = !empty($s['gave_up']);
        $name      = clean_opt((string)($s['name'] ?? ''), 60);
        $anon      = !empty($s['anonymous']) ? 1 : 0;

        $rawEmail = clean_opt((string)($s['email'] ?? ''), 255);
        $hash     = null;
        if ($rawEmail !== null) {
            if (!filter_var($rawEmail, FILTER_VALIDATE_EMAIL)) { $out['message'] = 'bad email'; $results[] = $out; continue; }
            $hash = hash('sha256', mb_strtolower($rawEmail));
        } elseif (!empty($s['email_hash']) && preg_match('/^[a-f0-9]{64}$/', (string)$s['email_hash'])) {
            $hash = (string)$s['email_hash'];
        }

        $started  = local_dt($startSec, $tz);
        $finished = local_dt($endSec, $tz);
        $publicId = '';
        $ins = db()->prepare(
            'INSERT INTO sessions (public_id, user_id, name, anonymous, email, email_hash, duration_sec, completed_sec,
                                   strikes, video_id, created_at, last_seen, finished_at, client_uuid)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        );
        $saved = false;
        for ($try = 0; $try < 5 && !$saved; $try++) {
            $publicId = substr(strtr(base64_encode(random_bytes(12)), '+/', '-_'), 0, 10);
            try {
                $ins->execute([$publicId, null, $name, $anon, $rawEmail, $hash, $duration, $completed, $strikes, null,
                               $started->format('Y-m-d H:i:s'), $finished->format('Y-m-d H:i:s'),
                               $finished->format('Y-m-d H:i:s'), $uuid]);
                $saved = true;
            } catch (PDOException $e) {
                if (strpos($e->getMessage(), 'client_uuid') !== false) { // lost a race with a retry
                    $out['status'] = 'duplicate'; $results[] = $out; continue 2;
                }
                if ($try === 4) { throw $e; }                          // public_id clash: retry
            }
        }

        // Streak: same rule as session-finish.php, using the day the session ended.
        $clean    = ($strikes === 0) || empty($CONFIG['require_clean_for_streak']);
        $reached  = $isFree ? ($completed >= 600) : ($completed >= $duration);
        if ($reached && $clean && !$gaveUp && $hash !== null) {
            $day = $finished->format('Y-m-d');
            $sel = db()->prepare('SELECT current_streak, best_streak, last_day FROM streaks WHERE email_hash = ?');
            $sel->execute([$hash]);
            $st = $sel->fetch();
            if (!$st) {
                db()->prepare('INSERT INTO streaks (email_hash, current_streak, best_streak, last_day) VALUES (?,1,1,?)')
                    ->execute([$hash, $day]);
            } elseif ((string)$st['last_day'] < $day) {               // same-day or older sessions leave it alone
                $yesterday = (new DateTimeImmutable($day, $tz))->modify('-1 day')->format('Y-m-d');
                $cur  = ((string)$st['last_day'] === $yesterday) ? (int)$st['current_streak'] + 1 : 1;
                $best = max((int)$st['best_streak'], $cur);
                db()->prepare('UPDATE streaks SET current_streak = ?, best_streak = ?, last_day = ? WHERE email_hash = ?')
                    ->execute([$cur, $best, $day, $hash]);
            }
        }

        [$cur, $best] = streak_for($hash);
        $results[] = ['client_uuid' => $uuid, 'status' => 'saved', 'public_id' => $publicId,
                      'streak_current' => $cur, 'streak_best' => $best];
    } catch (Throwable $e) {
        error_log('LockIn sync failed: ' . $e->getMessage());
        $results[] = ['client_uuid' => $uuid, 'status' => 'error'];   // app keeps it queued and retries
    }
}

json_out(['ok' => true, 'results' => $results]);
