# Caribbean Dawah Association website

*Real questions. Real answers. Right where you are.*

A fast one-page website for the Caribbean Dawah Association (CDA), Princes Town, Trinidad and Tobago, with a built-in **Site admin** at `/admin/` where CDA can change everything on the page: projects, albums of photos and videos, bank details, text and links.

- Plain HTML, CSS and JavaScript. No database and no build step.
- Hosted on **Netlify**. The admin uses Netlify Functions and Netlify Blobs (both built in, nothing extra to set up).
- Built to the approved CDA Brand Guidelines v1.0 (Georgia + Arial, the logo-sampled palette, real photos only).

---

## 1. Put the site live on Netlify (about 10 minutes)

### A. Create the site

1. Create a free account at <https://app.netlify.com/signup> (CDA should own this account).
2. Go to **Projects** (called **Sites** in older screens) **→ Add new project → Deploy manually**.
3. Unzip `cda-website.zip`, then drag the **unzipped folder** onto the upload box. Stay logged in while it uploads.
4. Netlify gives the site an address like `https://something.netlify.app`. Open it: the website should appear.

### B. Set the admin password

1. In the project, open **Project configuration → Environment variables → Add a variable** (older screens say *Site configuration*).
2. Key: `ADMIN_PASSWORD`. Value: a password of **at least 16 characters**. Best: four random, unrelated words (for example from a password manager's passphrase generator). Do not use the organisation's name, dates or phone numbers. Scopes: keep **All scopes** (it must include **Functions**).
3. Environment variables only reach the site on the next deploy, so go to **Deploys** and drag the same folder onto the page again.
4. Open `https://<your-site>/admin/` and sign in with that password.

To change the password later: edit `ADMIN_PASSWORD`, then deploy again. Everyone who was signed in is signed out.

### C. Check it worked (2 minutes, do this every time you deploy)

Open these in a browser:

1. `https://<your-site>/` shows the website.
2. `https://<your-site>/api/session` shows a short line of text starting with `{"ok":true`.
3. `https://<your-site>/admin/` shows the **password box** (not a message saying the editor only works on Netlify).
4. `https://<your-site>/README.md` shows the "page could not be found" page.

If 2 or 3 fail, Netlify published the pages but not the two small server functions in `netlify/functions/`. Deploy with Netlify's command-line tool instead, which always includes them. It needs **Node.js** (install the "LTS" version from <https://nodejs.org>), then open a terminal inside the unzipped folder and run:

```bash
npx netlify-cli login
```

```bash
npx netlify-cli deploy --prod --dir .
```

Choose the existing project when asked. (Connecting the project to a GitHub repository under **Project configuration → Build & deploy** works too.) Always redeploy the same way afterwards: a deploy without the functions also stops photos uploaded from the admin from showing.

### D. Connect the .tt domain

1. In Netlify: **Domain management → Add a domain** and enter the domain (e.g. `caribbeandawah.tt`).
2. Netlify shows exactly which DNS records to add. Add them at the .tt registrar (or switch the domain's nameservers to Netlify DNS, which Netlify walks you through).
3. Once DNS has updated (minutes to a few hours), Netlify issues the free HTTPS certificate automatically.

---

## 2. Editing the website (for CDA)

Open `https://<your-domain>/admin/` and sign in. Pick a section on the left, make changes, press **Preview** to check them, then **Publish**. The website shows your changes within about a minute.

| Section | What you can change |
| --- | --- |
| Projects & events | Add, edit, reorder or remove projects. Upcoming events move to "Recent" by themselves once their date has passed. |
| Albums (photos & videos) | One folder per project. **+ Add photos** (straight from a phone; they are resized automatically), **+ Add a video link** (paste a Facebook, YouTube, Instagram or TikTok link), captions, reorder, choose the cover, remove. |
| Donations & bank details | The bank accounts shown in the Give section (currently "General donations & Sadaqah" and the "Zakat account"), SWIFT code, the steps and notes. |
| Impact numbers, Top of page, Who we are, Our work, Featured story, Reflection quote, Get involved, Contact & social links, Search engines | All the text, photos and links in those parts of the page. |
| History & undo | Every publish keeps a copy of the previous version (the last 30). Press **Restore** to go back. |

Good to know:

- Videos are not uploaded to the website itself. Post them on Facebook / YouTube / Instagram / TikTok first, then paste the link. They play right inside the album, and the page stays fast.
- Photos you remove are cleaned up automatically (unless an older version in History still uses them).
- If two people edit at the same time, the second one to press Publish is warned instead of silently overwriting the other.
- After 5 wrong passwords a device is paused for 15 minutes. A browser that has signed in successfully before is never locked out by other people's wrong guesses.
- Netlify's free plan is plenty for a site like this. If the site ever grows a lot, check usage under **Team settings → Usage & billing**.

---

## 3. For developers

```
index.html, 404.html        The page
assets/                     CSS, JS (site.js renders everything from the content), logo and icons
content/site.json           Content shipped with the site (used until the first publish from the admin)
uploads/                    Photos shipped with the site
admin/                      The Site admin (index.html, admin.js, admin.css)
netlify/functions/          api.mjs (/api/*) and media.mjs (/media/*): tiny wrappers that hold the routes
netlify/lib/                Self-contained bundles of the function code (generated, no npm install needed)
functions-src/              Source of the functions (edit here, then `npm run build:functions`)
netlify.toml                Functions folder, security headers and caching
```

How content flows: the page asks `/api/content` for content saved from the admin (stored in Netlify Blobs). Until the first publish, or when the site is not on Netlify (e.g. the GitHub Pages preview), it falls back to `content/site.json`. Photos uploaded from the admin are stored in Netlify Blobs and served from `/media/<name>`.

Local development (needs Node 20+ and the Netlify CLI):

```bash
npm install
```

```bash
npm run build:functions
```

```bash
echo "ADMIN_PASSWORD=choose-a-local-test-password" > .env && netlify dev
```

Then open <http://localhost:8888> and <http://localhost:8888/admin/>.

`npm run zip` builds the hand-over zip in `dist/`. Once the domain is known, run `npm run zip -- --domain=https://your-domain.tt` so link previews (WhatsApp, Facebook) use it.

---

## 4. Before launch: confirm with CDA

- **Both bank accounts, digit by digit.** The Zakat account (…4253766) and SWIFT code came from Brother Asad. The general account (…4253731) was read from CDA's own soup-kitchen appeal on Facebook and still needs confirming.
- November fundraiser and dawah workshop dates, venues and ticket details.
- Whether the "centre for women and children" goal can be shared publicly.
- The impact numbers (20,000+ meals a year, ~300 families, 5 markets, 100% volunteer).
- Higher-resolution photos: most current photos come from Facebook and are small.
- Consent for identifiable people in photos and videos, per CDA's filming ethics policy.
