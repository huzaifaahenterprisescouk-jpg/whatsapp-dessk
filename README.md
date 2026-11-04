# WhatsApp Desk

One WhatsApp Business number, a small team, and automatic routing by organization.

* A customer messages your number and gets a tap-to-choose menu.
* If they say which organization they are from ("I'm from Hilton"), the chat goes to the person who handles that organization (main person, then backup, then the least busy member).
* Customers can send an Order ID (or just ask "track my order") and the bot answers from your Excel sheet.
* Your team answers from a shared inbox with live updates, hand-over, and resolve/reopen.

No packages to install. It runs on plain **Node.js 20 or newer**.

## 1. Try it in 1 minute (no WhatsApp needed)

```
node server.js
```
Open http://localhost:3000 . Sign in with **username + password**: admin / `1234` (the `ADMIN_PIN` in `.env` is the first admin password), or a demo team member (sara / 1111, bilal / 2222, hina / 3333, omar / 4444).
Click **Test phone** (bottom right) and chat like a customer: say "hi", pick *I'm from an organization*, type "Hilton". Then open the Inbox as Sara and watch it arrive.
Try tracking with order `ORD-1001`.

## 2. Make it your own
* **Team** – add your 5–6 people, give each a **username and password** (Team → Add team member).
* **Organizations** – add each company, other names people use for it, the person who handles it, and a backup.
* **Order tracking** – add one sheet per company, then link it to OneDrive or drag its Excel file onto the page. Use *Merge* for daily updates (matching Order IDs are updated, the rest kept). Column names are flexible (e.g. "Order No", "Mobile", "Company"). Put phone numbers with country code (e.g. 923001234567) so customers see their orders just by messaging.
* **Settings** – edit every message the bot sends, and the four menu buttons.

### Order sheets: one per company (BAFL, other clients…)
**Order tracking → Add company sheet.** Give each company its own sheet: a name (e.g. `BAFL`), its OneDrive / SharePoint share link (or leave the link empty and upload its Excel file), and how often to re-read it. Each sheet has its own **Columns** button, so BAFL can have "P.R no / PO no / CN no" in different columns from another company. Syncing or uploading one sheet only replaces **that company's** orders; the others are never touched.

* A customer who sends a PO, P.R or CN number gets the answer from whichever sheet contains it.
* If the customer already told the bot which organization they are from (e.g. "I'm from BAFL"), that company's sheet is used first, so a PO number that exists in two companies' sheets shows the right one. Name the sheet the same as the organization (or one of its "other names").
* A customer already connected to a team member can still send just a number (e.g. `366809`) and the bot answers instantly from their company's sheet.
* If a number is in several sheets and the customer's company is not known, every match is shown with a `Company:` line.

### Microsoft app (client) ID — for OneDrive / Excel links
OneDrive often refuses to give a file to a program that is not signed in ("401 unauthenticated"), especially for the newer `1drv.ms/x/c/…` links. Give the desk a Microsoft app (client) ID, sign in once, and it reads your sheets as a real Microsoft user (read-only, through Microsoft Graph). Then every link works, even "Specific people" links, as long as the account you sign in with can open them.

1. **portal.azure.com** (a free Microsoft account is enough) → **App registrations** → **New registration**. Name `WhatsApp Desk`. Supported account types: *Accounts in any organizational directory and personal Microsoft accounts*. Leave Redirect URI empty. Register.
2. Copy the **Application (client) ID**.
3. **Authentication** → *Advanced settings* → **Allow public client flows = Yes** → Save.
4. **API permissions** → Add a permission → Microsoft Graph → **Delegated** → **Files.Read.All** (press *Grant admin consent* if your company requires it).
5. In the app: **Order tracking → Microsoft sign-in → Set up** (or Settings → Microsoft app (client) ID). Paste the client ID, press **Sign in with Microsoft**, open `microsoft.com/devicelogin`, type the code shown, and sign in with the account that can open your sheets. Then press **Sync now** on each sheet.

You can also set `MS_CLIENT_ID` (and optionally `MS_TENANT`) in `.env`. The refresh token is stored in `data/db.json`; keep that file private. Nothing is ever written to OneDrive.

### Scheduled email reports
**Reports → Email settings**: enter the mailbox the reports are sent from (Gmail: `smtp.gmail.com`, port 587, STARTTLS, use an *App password*; Microsoft 365: `smtp.office365.com`, port 587, STARTTLS, SMTP sign-in must be enabled for that mailbox). Press *Save & send test*.
**Reports → New report**: choose the data (organizations, statuses, updated in the last N days, text, columns), the files (Excel, PDF or both), the email addresses, the time and the days. Make as many reports as you like, each with its own data and its own people, e.g. "Shipped orders" to the warehouse every morning and one report per organization to its account manager every Monday. *Send now* sends immediately, *PDF / Excel* download a copy. Reports read the same order list as WhatsApp, so with the OneDrive link connected they always contain your latest Excel data. Times use the server's time zone (default Asia/Karachi, change with `TZ` in `.env`). If the server was off at the scheduled time, the report is sent when it starts again (within 90 minutes).

## Shared email inbox (fully integrated with Gmail)
Several Gmail addresses, several people, each seeing only their own companies' mail. Everything stays in step with Gmail.

1. **Gmail side (once per address):** turn on 2-Step Verification, then Google Account → Security → *App passwords* → create one. In Gmail → Settings → *Labels*, keep **All Mail** set to "Show in IMAP" (default).
2. **Email → gear button** (admin) → *Add Gmail address*. Add as many as you like. Optionally mark a mailbox as **dedicated to a company**: everything arriving there goes to that company's person.
3. **Organizations → Edit:** fill *Email domains or addresses* (e.g. `hilton.com, buyer@hilton.com`) and *Handled by* (+ backup). Mail from those senders goes to that person; a company name in the subject also matches. Unmatched mail waits in **Unassigned** for the admin.
4. **Each person sees only their own emails** (the admin sees everything).

**What syncs with Gmail (both directions):** read/unread, star, **Done = archive** (and *Move to inbox*), and labels (add, remove, create new ones; accents work). Changes made in Gmail itself, including deleting a mail, show up in the app at the next check (1–60 min, you choose or press *Sync*).
**What people can do:** read HTML emails (shown in a sandbox, remote pictures hidden until "Show pictures"), reply / reply all / new email with attachments, download attachments, search by subject, sender, label or company, filter by label or mailbox, hand a thread over. Replies are sent from the chosen Gmail address (name of the person + mailbox name) and land in Gmail's *Sent*; mail you send from Gmail directly also appears here.

Notes: the app reads Gmail's **All Mail**, so every label is visible, and drafts, spam and trash are ignored. Non-Gmail servers (e.g. Microsoft 365: `outlook.office365.com` / `smtp.office365.com`) work with read + star sync only; labels and archive are Gmail features. Attachments are stored in `data/mail/`. Removing a mailbox in the app never deletes anything in Gmail. No npm packages are needed.

## Retail shops and QuickBooks (Online and Desktop)
**Retail shops** page: every shop has an account number. In WhatsApp a shop chooses *Retail shop account*, sends its number and gets its details, **sales person**, price list (by region or per shop), balance and open invoices, and its orders. A shop that is new types **NEW**, answers a few questions (name, contact, phone, address, city, region: Sindh, Punjab, Khyber Pakhtunkhwa, Balochistan… editable under *Regions & settings*) and receives its own account number such as `RT-PB-0001`.

* **QuickBooks Online (live):** *Retail shops → QuickBooks Online → Connect*. Create an app at developer.intuit.com (QuickBooks Online and Payments, scope Accounting), paste its Client ID and secret, add the redirect address shown in the dialog to the Intuit app, and approve. The desk then reads customers, products and open invoices every few minutes, and **every shop that registers in WhatsApp is created in QuickBooks as a customer** (display name `Shop (RT-PB-0001)`, phone, address, and `Account No: …` in Notes). If QuickBooks is unreachable the shop is kept and sent later (*Send waiting shops*). Existing QuickBooks customers use the number written as `Account No: XXXX` in their Notes, otherwise `QB-<id>`. Region comes from the billing State/Province or City.
* **QuickBooks Desktop / Excel:** Desktop has no cloud connection, so export the customer list, products and open invoices to Excel/CSV and upload or link them (OneDrive, or a NAS folder). New shops are always appended to `data/retail-new-shops.csv` and can be downloaded as **New shops (QuickBooks CSV)** to import into Desktop.
* New shops can be marked *pending* until an administrator approves them (*Regions & settings*), but they are sent to QuickBooks straight away when automatic creation is on.
* Environment alternatives: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENV` (`sandbox` or `production`). Intuit only accepts an https redirect address for Production (http://localhost is fine for testing).

## 3. Connect your real WhatsApp number
1. Go to https://developers.facebook.com → *Create app* → type **Business** → add the **WhatsApp** product.
2. In *WhatsApp → API Setup* copy the **Phone number ID** and an access token. (The temporary token expires in 24h; for production create a *System User* token in Business Settings with `whatsapp_business_messaging` permission.)
3. Copy `.env.example` to `.env`, fill in `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WEBHOOK_VERIFY_TOKEN`, `APP_SECRET`, change `ADMIN_PIN`, and set `SEED_DEMO=false` once you have added your own data. Restart the server.
4. Meta needs a **public https address** for the webhook. Host this on any server/VPS (`node server.js`, ideally behind a reverse proxy with https, kept running with pm2 or systemd), or for testing use a tunnel: `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.
5. In *WhatsApp → Configuration → Webhook*: Callback URL `https://YOUR-ADDRESS/webhook`, Verify token = your `WEBHOOK_VERIFY_TOKEN`. Then **subscribe to `messages`**.
6. Message your number from your phone. The dashboard switches from *Demo mode* to *WhatsApp connected*.

## Things to know
* **24-hour rule.** WhatsApp only allows free-form replies within 24 hours of the customer's last message. After that, Meta requires an approved template message. The dashboard tells the agent when a reply is blocked.
* **Business-initiated messages** (e.g. pushing "your order shipped" without the customer asking) need approved templates. This version answers customers when they ask; proactive updates can be added with a template.
* **Data** is stored in `data/db.json`. Back it up. Keep the dashboard behind https if exposed to the internet; set `APP_SECRET`, and change the default admin password right after the first sign-in.
* **One WhatsApp number cannot also be used in the normal WhatsApp Business phone app** at the same time as the Cloud API (use a number dedicated to this).

## Files
```
server.js        web server, API, WhatsApp webhook
lib/bot.js       menu flow, organization matching, routing
lib/orders.js    Excel import and order lookup
lib/sync.js      company sheets: live OneDrive / SharePoint / folder sync
lib/msgraph.js   Microsoft app (client) ID sign-in + Graph file download
lib/qbo.js       QuickBooks Online: live customers/products/invoices, creates new shops
lib/reports.js   scheduled PDF + Excel email reports
lib/pdf.js       PDF writer
lib/mailer.js    email (SMTP) sender
lib/imap.js      Gmail/IMAP reader + email parser
lib/inbox.js     shared email inbox: routing, threads, replies
lib/xlsx.js      built-in .xlsx reader (no dependencies)
lib/whatsapp.js  WhatsApp Cloud API sender
public/          the dashboard
```

## Running on a Synology NAS (Container Manager)
1. DSM → Package Center → install **Container Manager**.
2. In File Station create `docker/whatsapp-desk` and upload the unzipped folder contents there. Copy `.env.example` to `.env` and fill it in (set `SEED_DEMO=false`).
3. Container Manager → **Project** → Create → path `docker/whatsapp-desk` → it picks up `docker-compose.yml` → Build and start. Your data lives in the `data` folder next to it, so updates never erase it.
4. Open `http://NAS-IP:3000` on your network to use the dashboard.
5. Public https for WhatsApp (pick one):
   * **Synology DDNS + reverse proxy:** Control Panel → External Access → DDNS (free `yourname.synology.me`). Control Panel → Security → Certificate → add a Let's Encrypt certificate. Control Panel → Login Portal → Advanced → Reverse Proxy → create a rule: source HTTPS `yourname.synology.me` port 443 → destination HTTP `localhost` port 3000. On your router forward port 443 to the NAS.
   * **Cloudflare Tunnel** (no router changes): run the `cloudflare/cloudflared` container pointing to `http://whatsapp-desk:3000`.
   Then use `https://yourname.synology.me/webhook` as the Callback URL in Meta. QuickConnect does not work for webhooks.

## OneDrive sheet link troubleshooting
If "Sync problem" says OneDrive refused access even though the file is set to *Anyone with the link can view*: newer `1drv.ms/x/c/...` links often cannot be read automatically. In OneDrive open the file → Embed → Generate, copy the address inside `src="…"`, and paste that instead. The app now also tries several other download methods and lists what it tried in the error message.

### Most reliable option: read the Excel file from a folder on your NAS (no link needed)
1. On the Synology, install **Cloud Sync** and sync your OneDrive folder (or just the file) to a NAS folder, e.g. `docker/whatsapp-desk/sheets`.
2. Keep the `./sheets:/sheets:ro` line in `docker-compose.yml` (already added), so the container sees that folder.
3. In the app, paste the path instead of a link in a company sheet: `/sheets/bafl.xlsx` (your file name), choose how often to check, **Save**. Editing the sheet in Excel updates OneDrive → the NAS → the app.

## Order tracking by PO / P.R / CN number
**Order tracking → Columns** on a company sheet (admin): choose the Excel **tab**, the **header row** (found automatically, so title rows above the headers are fine) and which column is **P.R no**, **PO no** and **CN no** (consignment / tracking). Columns with no header can be picked as "Column C". Tick the extra **details** customers should see (address, order date, dispatch date, packages…). A live preview shows exactly the WhatsApp reply.
Customers can then send any PO, P.R or CN number (e.g. `366809`) and get the status and details back. If the sheet has no Status column the app uses *Dispatched* (CN or dispatch date present), *Self collection* (CN says "self") or *Pending dispatch*. Works with the OneDrive link, the NAS folder path, or a file upload.

## Call / WhatsApp, PO-P.R finder, tracking suggestion, AI assistant
* **Phone numbers:** *Team → Phone* (or when adding a member) – save each person's number with country code (`923001234567`; `0300…` is converted automatically).
* **Customer calls the person who handles their company:** the customer types **call** in WhatsApp and gets the handler's name, number and a `wa.me` link (main person, or the backup if the main person is off duty). The hand-over message also tells them to type *call*.
* **Find PO / P.R / CN** (left menu): type any part of a PO, P.R, CN or order number. Every match shows status, company, customer, courier, and **Call / WhatsApp** buttons for the customer's number on the order *and* for the team member who handles that company (plus backup). Buttons: *Copy details*, *Open chat*, *Send tracking in chat*.
* **Tracking suggestion:** when the customer's latest message is a PO/P.R/CN number or a tracking question ("where is my order?"), a yellow banner appears above the message box with the ready-made details – **Send tracking details**, **Edit first** or **Dismiss**. If no order matches it offers a message asking for the PO / CN number.
* **AI assistant** (right panel in every chat): **Suggest a reply** puts a draft in the message box; **Ask** gives step-by-step guidance. Admins open **AI settings** to choose Google Gemini or Anthropic Claude and paste the API key (or set `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` in `.env`). Without a key it still drafts replies from the order data. The AI never sends anything by itself.

## Email signature with a GIF (each team member)
**Email → My signature** (left menu of the mail screen, or click the grey signature line under any message you are writing). Everyone edits only their own signature.
* Write the text with the toolbar (bold, colour, links…) or press *Fill with my name & phone*.
* **GIF / picture:** upload a GIF, PNG, JPG or WebP (max 1.5 MB), *or* paste a direct `https://…gif` link. Pick the width. The preview shows exactly what the receiver sees.
* The signature is added automatically to new emails, replies, forwards and scheduled emails, and also appears under the message while you write. Untick *Add this signature* to switch it off.
* An uploaded GIF is attached inside the email (inline), so Gmail and Outlook show it and it animates. A Giphy/Tenor *page* address does not work; use the direct `.gif` link.

## Routing mail by CC, To and forwarded mail (colleague → client → team member)
Incoming mail is now matched on **everyone involved**, in this order: the sender, the To / CC addresses, then the original sender inside a forwarded mail (`From: …` lines). The first address that matches a routing rule or a company goes to that company's person (backup if they are off duty).
* **My company's own addresses** (Email → Routing rules): add your own domains/addresses (e.g. `mrenterprises.com`). Mail from a colleague is then routed by the *client* in CC or in the forwarded text, not by the colleague. An explicit rule on a colleague's address still works.
* **Filter from an open conversation** (admin, the tag icon in the toolbar): pick the client address (or everyone at their domain), pick the team member, and optionally hand the conversation over right away. This creates a routing rule, so future mail like it goes to that person.
* The conversation header shows *(matched address)* when the person was chosen from CC/forwarded text. *Apply to existing mail* re-routes old conversations the same way (conversations you handed over by hand are left alone).

## Retail shops: admin + assigned people, one region each
The **Retail shops** page is visible only to the administrator and to team members the administrator gives regions to: **Team → Retail regions (sees only these)** – tick one or more regions per person.
* A person sees **only the shops, balances/invoices and totals of their own regions**. Other regions are completely hidden from them, and the QuickBooks / file-upload settings are admin only.
* **WhatsApp chats with retail shops** follow the same rule: you see a retail chat only if it is yours (assigned to you) or from one of your regions. This also covers live updates and direct links.
* People with no retail region do not get the menu item, and the server refuses the data. Only the administrator can change regions.

## Sign-in: username + password
* The sign-in page no longer lists your team. Each person types their own **username and password**.
* **Existing installs keep working:** the first time the new version starts, every person gets a username (their first name in lower case, e.g. `sara`) and their old PIN becomes their password. The administrator can change both under **Team → Username & password**; everyone can change their own password (**Change password**, needs the current one).
* Passwords are stored only as salted hashes, must be at least 6 characters, and a password change signs that person out of other devices. After 6 wrong tries for a username the sign-in is paused for 10 minutes.
* Only the administrator sees usernames of other people. Forgotten password: the administrator sets a new one.

## Team page layout
Each team card is compact (name, @username, on-duty switch, phone with Call/WhatsApp, "Looks after"). Click **Settings** on a card to open its details — phone, username & password, retail regions (admin) and *Remove from team*. They stay hidden until you click, and the panel stays open while you edit.

## WooCommerce (WhatsApp ordering, PDFs and payment approval)
Open **WooCommerce** in the menu (admin). 1) In WordPress go to WooCommerce → Settings → Advanced → REST API → Add key (Read/Write) and paste the address + keys. 2) Switch it on. From then on: a new store order sends the customer a WhatsApp message + PDF; **Approve payment** sends a receipt; **Ask address** sends buttons (*Use saved details* / *Type new address*); customers can type **shop** (or choose *Shop online*) to buy inside WhatsApp (bank transfer or cash on delivery) and send a payment screenshot in the chat. For customers who have not written to you in the last 24 hours, create approved message templates in Meta and enter their names under Settings → 4.
