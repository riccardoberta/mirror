# Registering Mirror in Microsoft Entra ID

Mirror signs in with the official Microsoft Authentication Library (MSAL Node) using OAuth 2.0
authorization code flow with PKCE, through your system browser, with a loopback redirect
(`http://localhost:<random port>`). It is a **public client**: there is no client secret anywhere.

You need an *app registration* once. It only tells Microsoft which permissions Mirror may ask for;
every sign-in still happens with your own account and consent. Nothing is published to a store and
nothing costs money.

Identifiers you will need to type into Mirror (Settings → Microsoft Entra application):

| Field in Mirror | Where it comes from |
|---|---|
| **Application (client) ID** | Overview page of the app registration (a GUID) |
| **Tenant** | `organizations` (any work/school account), or your organization's domain (e.g. `contoso.com`) or **Directory (tenant) ID**; `common` also allows personal accounts if the registration permits them |

Mirror never ships a client ID of its own: use the values from *your* registration.

---

## Option A — Register the app in your organization's tenant (preferred for a work/school account)

1. Sign in to <https://entra.microsoft.com> with your work or school account.
2. Go to **Identity → Applications → App registrations → + New registration**.
   - If the button is greyed out / you get *"You do not have permission to register applications"*,
     your tenant restricts app registrations ("Users can register applications = No"). Ask your IT
     help desk either to register the app for you with the settings below, or to grant you the
     **Application Developer** role. Alternatively use Option B.
3. Fill in:
   - **Name**: `Mirror` (any name; shown on the consent screen).
   - **Supported account types**: *Accounts in this organizational directory only (<your organization>
     only – Single tenant)*. (If you also want personal Microsoft accounts, choose
     *Accounts in any organizational directory and personal Microsoft accounts* — see Option B notes.)
   - **Redirect URI**: platform **Public client/native (mobile & desktop)**, value `http://localhost`.
     (MSAL Node appends a random port; Entra ignores the port for `localhost`. Do **not** use `https`
     here and do not add a path.)
4. Click **Register**. Copy the **Application (client) ID** and the **Directory (tenant) ID** from
   the Overview page.
5. **Authentication** blade:
   - Under *Mobile and desktop applications* make sure `http://localhost` is listed.
   - *Advanced settings → Allow public client flows*: **Yes**.
   - Leave *Implicit grant* unchecked (not used).
6. **API permissions** blade → *+ Add a permission → Microsoft Graph → Delegated permissions* and add:
   - `Files.ReadWrite` — read and write the signed-in user's own files (not `.All`)
   - `User.Read` — read the signed-in user's profile (to pin the account identity)
   - `offline_access` — refresh tokens so Clone works later without signing in again
   Remove anything else that may have been added by default.
   - If your tenant requires admin consent for these, click **Grant admin consent** (admin) or ask IT
     to grant it. Otherwise you will consent yourself on first sign-in.
7. **Certificates & secrets**: create **nothing**. Mirror does not use secrets.
8. In Mirror → Settings, enter the **Application (client) ID** and set **Tenant** to your
   organization's domain (e.g. `contoso.com`), the Directory (tenant) ID, or `organizations`.
   Press *Connect OneDrive*.

## Option B — Register the app in your own (free) tenant and sign in with the work account

Use this when you cannot register apps in your organization's tenant.

1. Sign in to <https://entra.microsoft.com> with a **personal** Microsoft account (any
   outlook.com / live.com account works; it gets a free default directory).
2. **App registrations → + New registration**: same values as Option A, but choose
   **Supported account types = Accounts in any organizational directory (Any Microsoft Entra ID
   tenant – Multitenant) and personal Microsoft accounts**.
3. Add redirect URI `http://localhost` (Public client/native), enable *Allow public client flows*,
   add the same three delegated Graph permissions.
4. In Mirror → Settings, enter the client ID and set **Tenant** to `organizations` (or your organization's domain).
5. On the first *Connect OneDrive* you will sign in with the work account. Your organization's tenant
   must allow users to consent to third-party multitenant applications. If you see
   *"Need admin approval"* (AADSTS65001/AADSTS90094), the tenant's consent policy blocks it: ask IT
   for an admin consent of this app (they can do it from the request, or by visiting the admin
   consent URL `https://login.microsoftonline.com/<your-domain>/adminconsent?client_id=<client id>`).
   In that case Option A is usually the smoother path.

## Personal Microsoft accounts

If you want to use a personal OneDrive instead, register with *Personal Microsoft accounts only*
(or the multitenant + personal option) and set **Tenant** to `consumers` (or `common`). Everything
else is identical. Note that OneDrive personal also exposes `sha1Hash`; Mirror uses `quickXorHash`
(available on both) and `sha1Hash` only as a fallback.

## Checklist / troubleshooting

| Symptom | Cause / fix |
|---|---|
| `AADSTS50011: The redirect URI ... does not match` | Add `http://localhost` under *Mobile and desktop applications* (not Web, not SPA). |
| `AADSTS7000218 ... client_assertion or client_secret` | *Allow public client flows* is **No**, or the redirect URI was added under the *Web* platform. Fix both. |
| `AADSTS65001 / Need admin approval` | Tenant requires admin consent for the permissions; ask IT. |
| `AADSTS50020 / user account from identity provider does not exist in tenant` | Registration is single-tenant in another tenant; use Option A or multitenant. |
| `AADSTS700016: Application not found in the directory` | Wrong **Tenant** in Mirror for a single-tenant registration; set it to your organization's domain or the tenant ID. |
| Browser shows "Signed in to Mirror" but the app says nothing | The loopback response did not reach the app (firewall blocking localhost?). Retry; check that nothing blocks `127.0.0.1`. |

Microsoft documentation: [Register an application](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app),
[Redirect URI restrictions](https://learn.microsoft.com/entra/identity-platform/reply-url),
[MSAL Node](https://learn.microsoft.com/entra/msal/node/).
