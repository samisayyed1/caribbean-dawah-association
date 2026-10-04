<?php
/**
 * Caribbean Dawah Association - admin API for regular PHP web hosting (cPanel etc).
 * Requires PHP 7.4+. Not used on GitHub Pages (PHP does not run there).
 *
 * Actions (all respond with JSON):
 *   GET  ?action=status   -> { ok, backend, configured, authed, csrf }
 *   POST ?action=hash     -> generate a password hash (only while no password is configured)
 *   POST ?action=login    -> sign in with the admin password (rate limited)
 *   POST ?action=logout
 *   GET  ?action=load     -> current content + version (for conflict detection)
 *   POST ?action=upload   -> store a batch of new images (safe to retry)
 *   POST ?action=save     -> write content/site.json, delete removed images
 */

declare(strict_types=1);

const MAX_CONTENT_BYTES = 1048576;      // 1 MB of JSON is far more than this site needs
const MAX_IMAGE_BYTES   = 10485760;     // 10 MB per image (the admin compresses to ~200 KB first)
const MAX_FILES         = 20;           // per upload request (PHP's default max_file_uploads)
const KEEP_BACKUPS      = 30;
const LOGIN_MAX_FAILS   = 5;
const LOGIN_WINDOW_SECS = 900;          // 15 minutes
const SESSION_IDLE_SECS = 7200;         // sign out after 2 hours idle

$ROOT        = dirname(__DIR__);
$CONTENT     = $ROOT . '/content/site.json';
$BACKUPS     = $ROOT . '/content/backups';
$UPLOADS     = $ROOT . '/uploads';
$DATA        = __DIR__ . '/data';

$ADMIN_PASSWORD_HASH = '';
if (is_file(__DIR__ . '/config.php')) {
    require __DIR__ . '/config.php';    // defines $ADMIN_PASSWORD_HASH
}
$configured = is_string($ADMIN_PASSWORD_HASH) && $ADMIN_PASSWORD_HASH !== '';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

function respond(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(string $msg, int $code = 400): void { respond(['ok' => false, 'error' => $msg], $code); }

$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['SERVER_PORT'] ?? '') === '443');
session_name('cda_admin');
session_set_cookie_params([
    'lifetime' => 0,
    'path'     => '/',
    'secure'   => $https,
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();

// Idle timeout
if (!empty($_SESSION['authed']) && (time() - (int)($_SESSION['last'] ?? 0)) > SESSION_IDLE_SECS) {
    $_SESSION = [];
    session_regenerate_id(true);
}
if (!empty($_SESSION['authed'])) {
    $_SESSION['last'] = time();
}
if (empty($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// When a request exceeds post_max_size PHP silently empties $_POST/$_FILES: report it clearly.
function ini_bytes(string $v): int {
    $v = trim($v); $n = (int)$v; $u = strtolower(substr($v, -1));
    if ($u === 'g') $n *= 1073741824; elseif ($u === 'm') $n *= 1048576; elseif ($u === 'k') $n *= 1024;
    return $n;
}
if ($method === 'POST' && empty($_POST) && empty($_FILES) && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
    $limit = ini_bytes((string)ini_get('post_max_size'));
    if ($limit > 0 && (int)$_SERVER['CONTENT_LENGTH'] > $limit) {
        fail('That upload is larger than this server allows (' . ini_get('post_max_size') . '). Try fewer photos at once.', 413);
    }
}

function require_post(): void {
    global $method;
    if ($method !== 'POST') fail('Method not allowed.', 405);
}
function require_csrf(): void {
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($sent) || !hash_equals($_SESSION['csrf'], $sent)) fail('Your session has expired. Please reload the page.', 403);
}
function require_auth(): void {
    if (empty($_SESSION['authed'])) fail('Please sign in.', 401);
}

/* ---------- Login rate limiting (per IP, stored outside the web root's public files) ---------- */
function ip_key(): string {
    return hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? 'unknown') . '|cda');
}
function attempts_file(): string {
    global $DATA;
    if (!is_dir($DATA)) @mkdir($DATA, 0750, true);
    return $DATA . '/login-attempts.json';
}
function read_attempts(): array {
    $f = attempts_file();
    $raw = '';
    $h = @fopen($f, 'c+');
    if ($h) { flock($h, LOCK_SH); $raw = (string)stream_get_contents($h); flock($h, LOCK_UN); fclose($h); }
    $all = json_decode($raw, true);
    if (!is_array($all)) $all = [];
    $now = time();
    foreach ($all as $k => $v) {
        if (!is_array($v) || ($now - (int)($v['t'] ?? 0)) > LOGIN_WINDOW_SECS) unset($all[$k]);
    }
    return $all;
}
function write_attempts(array $all): void {
    @file_put_contents(attempts_file(), json_encode($all), LOCK_EX);
}

/* ---------- Paths ---------- */
function valid_upload_name(string $name): bool {
    return (bool)preg_match('/^[a-z0-9][a-z0-9-]{0,100}\.(jpg|jpeg|png|webp)$/', $name);
}
function valid_upload_path(string $path): bool {
    if (strpos($path, 'uploads/') !== 0) return false;
    return valid_upload_name(substr($path, strlen('uploads/')));
}
function content_version(string $file): string {
    return is_file($file) ? sha1_file($file) : '';
}
/** Every "uploads/..." string referenced anywhere in the content. */
function referenced_uploads($v, array &$out): void {
    if (is_string($v)) { if (strpos($v, 'uploads/') === 0) $out[$v] = true; }
    elseif (is_array($v)) { foreach ($v as $x) referenced_uploads($x, $out); }
}

switch ($action) {

    case 'status':
        respond([
            'ok'         => true,
            'backend'    => 'php',
            'configured' => $configured,
            'authed'     => !empty($_SESSION['authed']),
            'csrf'       => $_SESSION['csrf'],
        ]);

    case 'hash':
        require_post();
        require_csrf();
        if ($configured) fail('A password is already configured.', 403);
        $pw = (string)($_POST['password'] ?? '');
        if (strlen($pw) < 12) fail('Please choose a password of at least 12 characters.');
        respond(['ok' => true, 'hash' => password_hash($pw, PASSWORD_DEFAULT)]);

    case 'login':
        require_post();
        require_csrf();
        if (!$configured) fail('No admin password is configured yet.', 403);
        $all = read_attempts();
        $key = ip_key();
        if (($all[$key]['n'] ?? 0) >= LOGIN_MAX_FAILS) fail('Too many attempts. Please wait 15 minutes and try again.', 429);
        $pw = (string)($_POST['password'] ?? '');
        if (!password_verify($pw, $ADMIN_PASSWORD_HASH)) {
            $all[$key] = ['n' => (int)($all[$key]['n'] ?? 0) + 1, 't' => time()];
            write_attempts($all);
            usleep(700000);
            fail('That password is not correct.', 401);
        }
        unset($all[$key]);
        write_attempts($all);
        session_regenerate_id(true);
        $_SESSION['authed'] = true;
        $_SESSION['last']   = time();
        $_SESSION['csrf']   = bin2hex(random_bytes(32));
        respond(['ok' => true, 'csrf' => $_SESSION['csrf']]);

    case 'logout':
        require_post();
        require_csrf();
        $_SESSION = [];
        session_regenerate_id(true);
        respond(['ok' => true]);

    case 'load':
        require_auth();
        if (!is_file($CONTENT)) fail('Content file is missing.', 500);
        respond(['ok' => true, 'content' => (string)file_get_contents($CONTENT), 'version' => content_version($CONTENT)]);

    case 'upload':
        require_post();
        require_auth();
        require_csrf();
        if (empty($_FILES['files']) || !is_array($_FILES['files']['name'])) fail('No photos received.');
        $f = $_FILES['files'];
        $count = count($f['name']);
        if ($count > MAX_FILES) fail('Too many photos in one request.');
        $finfo = new finfo(FILEINFO_MIME_TYPE);
        $allowed = ['image/jpeg' => true, 'image/png' => true, 'image/webp' => true];
        $accepted = [];
        for ($i = 0; $i < $count; $i++) {
            if ($f['error'][$i] !== UPLOAD_ERR_OK) fail('A photo failed to upload (error ' . (int)$f['error'][$i] . ').');
            $name = (string)$f['name'][$i];
            if (!valid_upload_name($name)) fail('Invalid file name.');
            if ($f['size'][$i] > MAX_IMAGE_BYTES) fail('A photo is too large.');
            $tmp = $f['tmp_name'][$i];
            if (!is_uploaded_file($tmp)) fail('Invalid upload.');
            $mime = $finfo->file($tmp);
            if (!isset($allowed[$mime]) || @getimagesize($tmp) === false) fail('Only JPG, PNG and WebP photos are allowed.');
            $dest = $UPLOADS . '/' . $name;
            if (is_file($dest)) {
                // A retry of an upload that already arrived is fine; a different file with the same name is not.
                if (filesize($dest) === (int)$f['size'][$i] && hash_file('sha256', $dest) === hash_file('sha256', $tmp)) continue;
                fail('A different photo with that name already exists.');
            }
            $accepted[] = [$tmp, $dest];
        }
        if (!is_dir($UPLOADS) && !@mkdir($UPLOADS, 0755, true)) fail('Upload folder is not writable.', 500);
        foreach ($accepted as [$tmp, $dest]) {
            if (!move_uploaded_file($tmp, $dest)) fail('Could not save a photo. Check folder permissions.', 500);
            @chmod($dest, 0644);
        }
        respond(['ok' => true, 'stored' => count($accepted)]);

    case 'save':
        require_post();
        require_auth();
        require_csrf();

        // 1. Validate content JSON
        $json = (string)($_POST['content'] ?? '');
        if ($json === '' || strlen($json) > MAX_CONTENT_BYTES) fail('Content is missing or too large.');
        $data = json_decode($json, true);
        if (!is_array($data) || !isset($data['hero'], $data['donate'])) fail('Content is not valid.');

        // 2. Refuse to overwrite changes someone else published since this editor loaded
        $base = (string)($_POST['base'] ?? '');
        if ($base !== '' && !hash_equals(content_version($CONTENT), $base)) {
            fail('Someone else published changes while you were editing. Copy anything you need, then reload the admin to get the latest version.', 409);
        }

        // 3. Every referenced photo must exist (uploads are sent first, in batches)
        $refs = [];
        referenced_uploads($data, $refs);
        foreach (array_keys($refs) as $r) {
            if (valid_upload_path($r) && !is_file($ROOT . '/' . $r)) fail('A photo did not finish uploading (' . basename($r) . '). Please publish again.');
        }

        // 4. Validate deletions (never delete something the new content still uses)
        $deletes = json_decode((string)($_POST['deletes'] ?? '[]'), true);
        if (!is_array($deletes)) fail('Invalid delete list.');
        foreach ($deletes as $d) {
            if (!is_string($d) || !valid_upload_path($d)) fail('Invalid file to delete.');
        }

        // 5. Back up current content, then write atomically (the validated JSON exactly as sent)
        if (!is_dir($BACKUPS)) @mkdir($BACKUPS, 0750, true);
        if (is_file($CONTENT)) {
            @copy($CONTENT, $BACKUPS . '/site-' . date('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '.json');
            $old = glob($BACKUPS . '/site-*.json') ?: [];
            sort($old);
            while (count($old) > KEEP_BACKUPS) @unlink(array_shift($old));
        }
        $tmpFile = $CONTENT . '.tmp-' . bin2hex(random_bytes(4));
        if (@file_put_contents($tmpFile, $json, LOCK_EX) === false || !@rename($tmpFile, $CONTENT)) {
            @unlink($tmpFile);
            fail('Could not save content. Check that the content folder is writable.', 500);
        }
        @chmod($CONTENT, 0644);

        // 6. Delete removed photos
        foreach ($deletes as $d) {
            if (isset($refs[$d])) continue;
            $p = $ROOT . '/' . $d;
            if (is_file($p)) @unlink($p);
        }

        respond(['ok' => true, 'version' => content_version($CONTENT)]);

    default:
        fail('Unknown action.', 404);
}
