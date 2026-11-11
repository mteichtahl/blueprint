# Chat API (WhatsApp-style, Nov 2026)

The API behind the Chat screens (screens doc rev 6: one chat list, conversation,
group/contact info, new chat → new group, announcements). Everything a person
writes (text, quotes, attachment titles, system notes) is sealed with the
conversation key; DynamoDB only holds ids, times and per-member state.

## Conversation types

| `type`             | Who's in it                                                   | Who can post                                                      |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `bmg-artist`       | Blueprint and one artist (`dm-<artistId>`)                    | both                                                              |
| `group`            | Blueprint and the artists it picked                           | Blueprint; artists unless "only admins can send"                  |
| `announcement`     | Blueprint to chosen artists, or `broadcast` (= "All artists") | Blueprint only; artists "reply privately" in their Blueprint chat |
| `artist-to-artist` | two artists                                                   | both; Blueprint can't read it                                     |

`broadcast` is kept as the id of the all-artists announcement; its `type` is reported as `announcement`.

## `GET /conversations`

Also records that the caller is online (used for "delivered" ticks and "last seen").

```jsonc
{
  "conversations": [
    {
      "conversationId": "grp-…",
      "type": "group", // bmg-artist | group | announcement | artist-to-artist
      "title": "Mixer Night performers",
      "description": "Open-mic slot …", // groups and announcements, else null
      "artists": [{ "artistId": "art_…", "displayName": "Chloe Poli" }],
      "access": "read-write", // read-write | read
      "canSend": true, // access and group settings combined
      "settings": {
        "onlyAdminsSend": false,
        "artistsShareFiles": true,
        "artistsAddMembers": false,
      }, // groups, else null
      "lastMessageAt": "…", // or null
      "preview": "Sounds good, I'll bring my own leads", // or null; "📎 Run sheet" for attachment-only
      "previewSender": "SARUN", // "You", a name, or null (direct chats from the other person)
      "previewTicks": "read", // sent | delivered | read, only when previewSender is "You"
      "unreadCount": 2, // capped at 99
      "pinned": false,
      "muted": false,
      "archived": false,
      "private": false, // true for artist-to-artist (lock note)
      "lastSeen": "…", // direct chats: the other side's last activity, else null
    },
  ],
}
```

Archived chats are included (flagged); the client shows them behind the "Archived" row.

## `POST /conversations`

```jsonc
{ "kind": "direct", "artistId": "art_…" }      // BMG→artist; artist→artist; artist with no artistId → their Blueprint chat
{ "kind": "group", "title": "…", "description": "…", "artistIds": ["art_…"],
  "settings": { "onlyAdminsSend": false, "artistsShareFiles": true, "artistsAddMembers": false } }  // BMG only
{ "kind": "announcement", "title": "…", "description": "…", "artistIds": ["art_…"] } // BMG only
```

→ `201 { conversationId }` (or `200` for an existing direct chat). Groups and announcements start with a system note ("Kyra created this group and added …"); added artists are notified.

## `PATCH /conversations/{id}` (BMG, groups and announcements)

`{ "title"?, "description"?, "settings"? }` → `200`. Changing the name or description adds a system note.

## `DELETE /conversations/{id}` (BMG admin, groups and announcements)

Deletes the group for everyone (its inbox rows go; messages stay sealed and unreachable). → `200`.

## Members

- `POST /conversations/{id}/members` `{ "artistIds": [...] }`: BMG, or an artist member when "artists can add members". Adds a system note; added artists are notified.
- `DELETE /conversations/{id}/members/{artistId}`: BMG removes an artist (or an artist leaves: their own id). System note.

## `PATCH /conversations/{id}/me` (each person's own state)

`{ "pinned"?, "muted"?, "archived"?, "clear"?: true, "star"?: { "messageId": "…", "starred": true } }` → `200 { pinned, muted, archived }`.
Clearing hides everything up to now for the caller only. Muted chats don't send email or push.

## `GET /conversations/{id}/messages?before=<cursor>`

Marks the conversation read for the caller.

```jsonc
{
  "conversationId": "…",
  "type": "group",
  "access": "read-write",
  "canSend": true,
  "firstUnreadMessageId": "…", // the first message after the caller's previous read, or null
  "messages": [
    {
      "messageId": "…",
      "createdAt": "…",
      "kind": "message", // message | system
      "text": "Yes, bring it.", // may be "" when only an attachment
      "senderName": "Blueprint",
      "senderRole": "bmg-admin",
      "senderArtistId": null,
      "mine": true,
      "ticks": "read", // mine only: sent | delivered | read
      "starred": false,
      "replyTo": {
        "messageId": "…",
        "senderName": "SARUN",
        "text": "Can I bring a backing track?",
      }, // or null
      "attachment": {
        // or null
        "kind": "file", // file | event | todo | submission | gig | feedback
        "id": "…",
        "artistId": "art_…" /* artist items */,
        "scope": "library" /* files: library | artist */,
        "title": "Mixer Night run sheet v2",
        "subtitle": "PDF · from the library",
      },
    },
  ],
  "nextBefore": "…", // or null
}
```

## `POST /conversations/{id}/messages`

```jsonc
{
  "text": "…", // 0–4000 chars; required unless there's an attachment
  "replyTo": { "messageId": "…", "conversationId": "…" }, // conversationId: quote from another chat the caller can read (announcement → private reply)
  "attachment": {
    "kind": "todo",
    "id": "…",
    "artistId": "art_…",
    "scope": "artist",
    "title": "…",
    "subtitle": "…",
  },
}
```

→ `201 { messageId, createdAt }`. Artists can't attach files in a group when "artists can share files" is off. The client decides what to show in a card; the API stores it sealed and never trusts it for access: opening a card goes through that item's own API.

**Uploading a file into a chat (rev 7).** There's no upload on this route. The app first uploads the file through the files API (`POST /artists/{artistId}/files`, or `/library` for Blueprint's groups and announcements), with `sharedWithArtistIds` set to the other artists in the chat. In an artist ↔ artist chat the file is stored `private`, so Blueprint can't open it. Once the malware scan is clean, the app posts a `file` card here. Recipients open the card with the file's own download endpoint, which returns a 5-minute link signed for them. Posting a file card also records where the file is used (`FILEUSE#…`), and a card for a deleted file reads "This file was deleted" (rev 8).

## `GET /directory`

`{ artists: [{ artistId, displayName }], team: [{ name: "Blueprint", ... }] }` — people you can start a chat with.
