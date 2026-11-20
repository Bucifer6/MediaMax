---
title: Users, permissions, invites and profiles
summary: Add users, invite people with a link, set what each account can do, and manage profiles and kids profiles.
section: admin
audience: admin
keywords: users, add user, invite, invite link, permissions, library access, rating limit, parental controls, kids, profiles, streams, transcoding, home only, downloads, live tv, dvr, request manager, disable, two-factor reset, sso, oidc
related: profiles, admin-requests, admin-setup
order: 3
---

## Adding people

- **Add user** (**Admin → Users**): create an account yourself and give the person the password.
- **Invites** (**Admin → Invites → New invite**): create a link they open to make their own account. Choose what **New users get**, how long the link works (**Expires after**: 1, 7, 30 or 90 days, or never) and **Max uses**. Then **Copy link** and send it.
- **Single sign-on (SSO)**: **Admin → Server settings → SSO** lets people sign in with your OpenID Connect provider (Authentik, Authelia, Keycloak…).

## Permissions

Open a user in **Admin → Users** to set:

| Setting | Effect |
|---|---|
| **Administrator** | Full access to server settings, users and branding. |
| **Library access** | Which libraries the user sees. |
| **Maximum content rating** | Titles rated above this are hidden. **Hide unrated titles** hides titles with no rating. |
| **Live TV**, **DVR recording**, **Downloads** | Turn each feature on or off. |
| **Allow transcoding** | When off, only direct play is allowed. |
| **Allow streaming outside the home network** | When off, the account only works at home. |
| **Max simultaneous streams** | Empty for unlimited. Shared by all the account's profiles. |
| **Request permissions** and quota | Per type (movies, shows, 4K, music, books): *No*, *Request* or *Auto* (auto-approve). |
| **Manage requests** | Approve and decline everyone's requests without being an admin. |
| **Disabled** | Blocks sign-in and revokes access. |

Select several users to **Bulk edit** them, and use **Default permissions** for new accounts. The **More** menu has **Reset two-factor** for someone who lost their authenticator.

## Profiles

Account owners add profiles themselves (**Settings → Profiles**). In **Admin → Users**, profiles are shown under their owner. **Profile settings** sets:

- **Profiles per account** (default 6) and whether profiles are allowed at all;
- **Default rating limit for kids profiles** and whether new kids profiles hide unrated titles;
- **Kids profiles can watch Live TV** (channels have no age ratings, so it's off by default).

A profile never gets more than its owner: the stricter rating limit wins and library access is the owner's subset.

## Passwordless profiles

**Admin → Server settings → General → Allow passwordless profiles** lets non-admin accounts without a password be opened from the profile picker, optionally with a PIN. Administrators always need a password.
