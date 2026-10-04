# Caribbean Dawah Association website

A fast, single-page website for the Caribbean Dawah Association (CDA), Princes Town, Trinidad and Tobago.

*Real questions. Real answers. Right where you are.*

- Plain HTML, CSS and JavaScript. No build step, no database, no monthly fees.
- Built to the approved CDA Brand Guidelines v1.0: Georgia + Arial, the six-colour palette sampled from the logo, the logo always on white and never below 120px, real photos only.
- Every section is driven by one file: `content/site.json`.
- A built-in **Site admin** at `/admin/` lets CDA add, edit and remove projects, events, photos and donation details without touching code.

## Structure

```
index.html              The page (sections are filled in from content/site.json)
assets/css/style.css    All styling, brand tokens at the top
assets/js/site.js       Renders the content, copy-to-clipboard, gallery viewer, menus
assets/img/             Logo, favicons, social preview image
content/site.json       ALL editable content (text, projects, gallery, bank details)
uploads/                Photos (managed by the admin)
admin/                  The Site admin (index.html, admin.js, admin.css, api.php)
```

## Editing content (Site admin)

Open `https://<your-site>/admin/`. The admin works in two ways and picks the right one automatically.

### A) While the site is on GitHub Pages (free)

1. Create a fine-grained access token: GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   - Repository access: *Only select repositories* → this repository.
   - Permissions → Repository permissions → **Contents: Read and write**.
2. Open `/admin/`, paste the token and sign in.
3. Make your changes, press **Preview** to check them, then **Publish**. Each publish is one commit, and the live site updates in about a minute.

The token is kept only in your browser and is never written into the website.

### B) On regular web hosting with PHP (cPanel and similar)

1. Upload all files to the hosting (public_html).
2. Copy `admin/config.sample.php` to `admin/config.php`.
3. Visit `/admin/`. It shows *First-time setup*: choose a password (12+ characters) and press **Generate hash**.
4. Paste the generated hash into `admin/config.php` as the value of `$ADMIN_PASSWORD_HASH`, then save.
5. Sign in at `/admin/` with that password.
6. Make sure `content/` and `uploads/` are writable by PHP (usually 755 folders are fine on cPanel).

Safety built in: CSRF protection, 5 wrong passwords locks sign-in for 15 minutes, uploads are checked to be real JPG/PNG/WebP images, nothing in `uploads/` can execute, and every save keeps a backup of the previous content in `content/backups/` (last 30).

### What the admin can change

Projects and events, the photo gallery (upload many at once, reorder, caption, remove), donation and bank details, impact numbers, the hero headline and photo, the Who We Are text and photo, the Our Work list, the featured story, the weekly reflection quote, Get Involved cards, contact and social links, and search engine text.

Photos are resized to 1600px wide and compressed in the browser before upload, so phone photos are fine to use directly. Photos you remove are deleted from the server unless they are still used somewhere else on the page.

Upcoming events move to **Recent** automatically once their date has passed.

## Running locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` directly from disk will not load the content, because browsers block local file fetches.)

To test the PHP admin locally: `php -S 127.0.0.1:8000`.

## Connecting the .tt domain

- **GitHub Pages:** Settings → Pages → Custom domain → enter the domain. At the domain registrar, add the DNS records GitHub shows (an `A`/`AAAA` set for the apex domain, or a `CNAME` for `www`). Tick *Enforce HTTPS* once the certificate is issued.
- **Web hosting:** point the domain's nameservers (or `A` record) to the hosting provider, then enable the free SSL certificate in cPanel and uncomment the HTTPS redirect in `.htaccess`.

## Before launch: confirm with CDA

- Bank details. The account number (`110000004253731`, RBC Royal Bank, Chequing / Business) was read from CDA's own soup kitchen video card on Facebook. Confirm every digit with the treasurer. Also ask for currency and SWIFT/branch details for overseas donors.
- November fundraiser and dawah workshops: dates, venues and ticket details.
- The "centre for women and children" goal: confirm CDA is happy to share it publicly.
- Impact numbers (20,000+ meals a year, ~300 families, 5 markets, 100% volunteer).
- Higher-resolution originals of the photos. Most current images were taken from Facebook and are small.
- Photo consent for identifiable people, per CDA's filming ethics policy.
