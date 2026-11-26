/* Channels data layer: the only code that talks to Supabase for chat (the Channels screen imports nothing else).
   Plain script, global functions on window, built on the global `sb` client. CONTRACT.md "Hub data layer".
   Every function resolves to {ok, data, error}: error is plain words for a non-technical person, and nothing here throws.
   chSubscribe is the one synchronous call: it returns the unsubscribe function itself (which also carries ok/data/error).

   The live tables (SCHEMA.md "Conversations"):
     channel_messages(id, channel_id, author_user, author_person, body, attachment_url, created_at, edited_at, deleted_at)
       a team message has author_user = the login; a client's message has author_person = their client_people id.
     channel_members(channel_id, user_id | person_id, member_role, last_read_at)
   Database functions (supabase/migrations/20261124_channels_rpcs.sql): my_channels(), mark_channel_read(c),
   channel_people(p_ids) (names for BOTH kinds of author), ensure_client_channel(p_client_id, p_name).
   A message's userId is author_user or author_person (both uuids, never the same); a client's message carries
   isClient: true and a name that says the company, so nobody mistakes who is talking.
   Files: there is no storage bucket yet, so sending files is refused in plain words. A message that already has an
   http(s) attachment_url shows it as one attachment {path: url, url, name}; chFileUrl hands such a link straight back. */
(function () {
  'use strict';

  var MAX_BODY = 8000;
  var NO_FILES = "Sending files isn't switched on yet. Send the message as text, or paste a link to the file.";
  var TYPING_GAP = 3000;             // ms between typing signals per channel

  var names = new Map();             // user id or client person id -> {name, role, kind, company}
  var typingSent = new Map();        // channelId -> last time we signalled
  var typingChans = new Map();       // channelId -> {chan, refs, idle}

  /* ---------- small helpers ---------- */
  function client() {
    try { if (typeof sb !== 'undefined' && sb) return sb; } catch (e) { /* not defined */ }
    return window.sb || null;
  }
  function Fail(message) { var e = new Error(message); e.chPlain = true; return e; }
  function plain(err, fallback) {
    if (!err) return fallback;
    if (err.chPlain) return err.message;
    var msg = String(err.message || err), code = String(err.code || '');
    if (/failed to fetch|networkerror|network request|load failed|fetch failed/i.test(msg)) return "Can't reach Aviance right now. Check your connection and try again.";
    if (code === 'PGRST301' || /jwt|not authenticated|session/i.test(msg)) return 'Your sign-in has run out. Please sign in again.';
    if (code === '42501' || /row-level security|permission denied|not authorized|unauthorized/i.test(msg)) return "You don't have access to do that.";
    if (code === 'P0001' && msg) return msg;   // our own database messages are already plain
    /* A function or table this database has not been given yet. coreFamily
       (core.js) is the one place that decides what KIND of failure something
       is, and this was the one kind the chat did not ask it about: against a
       database where my_channels() or drafts_pending() has not been applied,
       every screen in the hub said "that part isn't switched on yet" and the
       chat alone said "Couldn't load your channels." That reads as a fault and
       sends the owner hunting for one that is not there. */
    if (typeof coreFamily === 'function' && coreFamily(msg, code) === 'not-ready') {
      return typeof CORE_NOT_READY === 'string' ? CORE_NOT_READY : fallback;
    }
    return fallback;
  }
  function done(data) { return { ok: true, data: data === undefined ? null : data, error: null }; }
  function fail(err, fallback, data) { return { ok: false, data: data === undefined ? null : data, error: plain(err, fallback) }; }
  // wrap(fallback, fn): fn may throw or return {error}; the result is always {ok,data,error}
  function wrap(fallback, fn) {
    return async function () {
      try { return done(await fn.apply(null, arguments)); } catch (e) { return fail(e, fallback, e && e.partial); }
    };
  }
  function need(s) { if (!s) throw Fail('The chat is not ready yet. Please reload the page.'); return s; }
  function check(res, fallback) {   // supabase result -> data, or throw a plain-words error
    if (res && res.error) throw Fail(plain(res.error, fallback));
    return res ? res.data : null;
  }
  function isWebLink(u) { return /^https?:\/\/[^\s]+$/i.test(String(u || '')); }
  function linkName(u) {
    try { var last = decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); return last || 'Attached link'; } catch (e) { return 'Attached link'; }
  }
  function iso(v) { if (v instanceof Date) return v.toISOString(); return String(v); }
  function noop() {}

  async function myId() {
    var s = need(client());
    var r = await s.auth.getSession();
    var u = r && r.data && r.data.session && r.data.session.user;
    if (!u) { var g = await s.auth.getUser(); u = g && g.data && g.data.user; }
    if (!u || !u.id) throw Fail('Your sign-in has run out. Please sign in again.');
    return u.id;
  }

  /* ---------- names (cached): team logins and client people, one lookup ---------- */
  async function loadNames(ids) {
    var want = [];
    (ids || []).forEach(function (id) { if (id && !names.has(id) && want.indexOf(id) < 0) want.push(id); });
    if (want.length) {
      var asked = false;
      try {
        var res = await need(client()).rpc('channel_people', { p_ids: want });
        asked = !(res && res.error);
        (res && res.data || []).forEach(function (p) {
          if (!p || !p.id) return;
          var isClient = p.kind === 'client' || p.role === 'client';
          names.set(p.id, { name: p.name || (isClient ? 'Client' : 'Someone'), role: p.role || null, kind: isClient ? 'client' : 'team', company: p.company || null });
        });
      } catch (e) { /* names are nice to have: the thread says "Someone" this once */ }
      /* Only an answered lookup is remembered. If the lookup itself failed, nothing is cached, so the next
         message asks again instead of everyone reading as "Someone" until the page is reloaded. */
      if (asked) want.forEach(function (id) { if (!names.has(id)) names.set(id, { name: 'Someone', role: null, kind: null, company: null, guess: true }); });
    }
    return names;
  }
  function nameOf(id) { var n = names.get(id); return n ? n.name : 'Someone'; }
  // What the thread shows as the author: a client always reads "Pat Lee (Stone Roofing)".
  function labelOf(id, isClient) {
    var n = names.get(id) || {};
    var base = n.name || (isClient ? 'Client' : 'Someone');
    if (!isClient) return base;
    return n.company ? base + ' (' + n.company + ')' : base + ' (client)';
  }
  function authorOf(r) { return r.author_user || r.author_person || null; }

  function mapMessage(r) {
    var deleted = !!r.deleted_at;
    var isClient = !r.author_user && !!r.author_person;
    var id = authorOf(r), n = names.get(id) || {};
    var url = !deleted && isWebLink(r.attachment_url) ? String(r.attachment_url) : null;
    return {
      id: r.id, channelId: r.channel_id, userId: id, name: labelOf(id, isClient),
      authorKind: isClient ? 'client' : 'team', isClient: isClient, company: isClient ? (n.company || null) : null,
      body: deleted ? '' : (r.body || ''),
      attachments: url ? [{ path: url, url: url, name: linkName(url), size: 0, type: '' }] : [],
      createdAt: r.created_at, editedAt: r.edited_at || null, deleted: deleted
    };
  }
  async function mapMessages(rows) {
    await loadNames(rows.map(authorOf));
    return rows.map(mapMessage);
  }
  var MSG_TABLE = 'channel_messages';
  var MSG_COLS = 'id,channel_id,author_user,author_person,body,attachment_url,created_at,edited_at,deleted_at';

  /* ---------- reading ---------- */
  async function listRaw() {
    var data = check(await need(client()).rpc('my_channels'), "Couldn't load your channels.") || [];
    return data.map(function (c) {
      return { id: c.id, name: c.name, kind: c.kind, clientId: c.client_id || null, archived: !!c.archived_at, lastMessageAt: c.last_message_at || null, unread: Number(c.unread) || 0,
        company: c.company || null, purpose: c.purpose || null, lastBody: c.last_body || null };
    });
  }
  window.chListChannels = wrap("Couldn't load your channels.", listRaw);

  window.chUnreadTotal = wrap("Couldn't count unread messages.", async function () {
    var list = await listRaw();
    return list.reduce(function (n, c) { return n + (c.archived ? 0 : c.unread); }, 0);
  });

  window.chMessages = wrap("Couldn't load the messages.", async function (channelId, opts) {
    if (!channelId) throw Fail('Pick a channel first.');
    opts = opts || {};
    var limit = Math.max(1, Math.min(200, parseInt(opts.limit, 10) || 50));
    var q = need(client()).from(MSG_TABLE).select(MSG_COLS).eq('channel_id', channelId);
    if (opts.before) q = q.lt('created_at', iso(opts.before));
    var rows = check(await q.order('created_at', { ascending: false }).limit(limit), "Couldn't load the messages.") || [];
    return await mapMessages(rows.slice().reverse());
  });

  window.chSearch = wrap("Couldn't search the messages.", async function (text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return [];
    var pattern = '%' + t.replace(/[\\%_]/g, function (c) { return '\\' + c; }) + '%';
    /* the messages and the channel names are asked for together, not one after the other */
    var both = await Promise.all([
      need(client()).from(MSG_TABLE).select(MSG_COLS).ilike('body', pattern).is('deleted_at', null).order('created_at', { ascending: false }).limit(50),
      listRaw().catch(function () { return []; })   // names of channels are optional
    ]);
    var rows = check(both[0], "Couldn't search the messages.") || [];
    var chans = {};
    both[1].forEach(function (c) { chans[c.id] = c.name; });
    var mapped = await mapMessages(rows);
    return mapped.map(function (m) { m.channelName = chans[m.channelId] || ''; return m; });
  });

  /* ---------- writing ---------- */
  window.chSend = wrap("Your message didn't send. Please try again.", async function (channelId, body, files) {
    if (!channelId) throw Fail('Pick a channel first.');
    var text = String(body == null ? '' : body).trim();
    var list = Array.prototype.slice.call(files || []);
    if (!text && !list.length) throw Fail('Write a message first.');
    if (text.length > MAX_BODY) throw Fail('That message is too long. Keep it under ' + MAX_BODY + ' characters.');
    if (list.length) throw Fail(NO_FILES);
    var s = need(client());
    var uid = await myId();
    var res = await s.from(MSG_TABLE).insert({ channel_id: channelId, author_user: uid, author_person: null, body: text }).select(MSG_COLS).single();
    var row = check(res, "Your message didn't send. Please try again.");
    return (await mapMessages([row]))[0];
  });

  window.chEdit = wrap("Couldn't save your change.", async function (messageId, body) {
    if (!messageId) throw Fail('Pick a message first.');
    var text = String(body == null ? '' : body).trim();
    if (!text) throw Fail('A message can\'t be empty. Delete it instead.');
    if (text.length > MAX_BODY) throw Fail('That message is too long. Keep it under ' + MAX_BODY + ' characters.');
    var s = need(client()), uid = await myId();
    var rows = check(await s.from(MSG_TABLE).update({ body: text, edited_at: new Date().toISOString() }).eq('id', messageId).eq('author_user', uid).is('deleted_at', null).select(MSG_COLS), "Couldn't save your change.");
    if (!rows || !rows.length) throw Fail('You can only edit your own messages, in channels that are still open.');
    return (await mapMessages([rows[0]]))[0];
  });

  window.chDelete = wrap("Couldn't delete that message.", async function (messageId) {
    if (!messageId) throw Fail('Pick a message first.');
    var s = need(client()), uid = await myId();
    var rows = check(await s.from(MSG_TABLE).update({ deleted_at: new Date().toISOString() }).eq('id', messageId).eq('author_user', uid).is('deleted_at', null).select(MSG_COLS), "Couldn't delete that message.");
    if (!rows || !rows.length) throw Fail('You can only delete your own messages, in channels that are still open.');
    return (await mapMessages([rows[0]]))[0];
  });

  window.chMarkRead = wrap("Couldn't mark that channel as read.", async function (channelId) {
    if (!channelId) throw Fail('Pick a channel first.');
    check(await need(client()).rpc('mark_channel_read', { c: channelId }), "Couldn't mark that channel as read.");
    return { channelId: channelId };
  });

  // Only an http(s) attachment_url can be opened; there is no storage bucket to sign links from.
  window.chFileUrl = wrap("Couldn't open that file.", async function (path) {
    var p = String(path && (path.url || path.path) ? (path.url || path.path) : (path || ''));
    if (!isWebLink(p)) throw Fail("That file link isn't valid.");
    return p;
  });

  /* ---------- live updates and typing ---------- */
  function typingEntry(channelId) {
    var e = typingChans.get(channelId);
    if (e) return e;
    var s = need(client());
    var chan = s.channel('typing:' + channelId, { config: { broadcast: { self: false } } });
    e = { chan: chan, refs: 0, idle: null, handlers: [] };
    chan.on('broadcast', { event: 'typing' }, function (msg) {
      var p = (msg && msg.payload) || {};
      e.handlers.slice().forEach(function (h) { try { h({ userId: p.user_id, name: p.name || 'Someone' }); } catch (x) { /* never break the channel */ } });
    });
    chan.subscribe();
    typingChans.set(channelId, e);
    return e;
  }
  function releaseTyping(channelId) {
    var e = typingChans.get(channelId);
    if (!e) return;
    e.refs = Math.max(0, e.refs - 1);
    if (e.refs === 0) { try { client().removeChannel(e.chan); } catch (x) { /* already gone */ } typingChans.delete(channelId); }
  }

  window.chSubscribe = function (channelId, handlers) {
    handlers = handlers || {};
    var noopUnsub = function () {}; noopUnsub.ok = false; noopUnsub.data = null;
    try {
      if (!channelId) throw Fail('Pick a channel first.');
      var s = need(client());
      var live = s.channel('chat:' + channelId);
      var closed = false;
      function deliver(cb, row) {
        if (typeof cb !== 'function') return;
        loadNames([authorOf(row)]).then(function () { if (!closed) { try { cb(mapMessage(row)); } catch (x) { /* a screen error must not stop updates */ } } });
      }
      var filter = 'channel_id=eq.' + channelId;
      live.on('postgres_changes', { event: 'INSERT', schema: 'public', table: MSG_TABLE, filter: filter }, function (p) { if (p && p.new) deliver(handlers.onMessage, p.new); });
      live.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: MSG_TABLE, filter: filter }, function (p) { if (p && p.new) deliver(handlers.onUpdate, p.new); });
      live.subscribe();
      var te = typingEntry(channelId);
      te.refs += 1;
      var th = function (t) { if (!closed && typeof handlers.onTyping === 'function') handlers.onTyping(t); };
      te.handlers.push(th);
      var unsub = function () {
        if (closed) return;
        closed = true;
        try { s.removeChannel(live); } catch (x) { /* ignore */ }
        var i = te.handlers.indexOf(th); if (i >= 0) te.handlers.splice(i, 1);
        releaseTyping(channelId);
      };
      unsub.ok = true; unsub.data = unsub; unsub.error = null;
      return unsub;
    } catch (e) {
      noopUnsub.error = plain(e, "Couldn't connect to live updates. New messages will show when you reload.");
      return noopUnsub;
    }
  };

  window.chTyping = wrap("Couldn't send the typing signal.", async function (channelId) {
    if (!channelId) throw Fail('Pick a channel first.');
    var now = Date.now(), last = typingSent.get(channelId) || 0;
    if (now - last < TYPING_GAP) return { sent: false };
    typingSent.set(channelId, now);
    var uid = await myId();
    await loadNames([uid]);
    var e = typingEntry(channelId);
    if (!e.idle) e.refs += 1;                       // hold the line open while typing...
    if (e.idle) clearTimeout(e.idle);
    e.idle = setTimeout(function () { e.idle = null; releaseTyping(channelId); }, 10000);   // ...and let go 10 s after the last key
    if (e.idle && e.idle.unref) e.idle.unref();
    var r = await e.chan.send({ type: 'broadcast', event: 'typing', payload: { user_id: uid, name: nameOf(uid) } });
    return { sent: r === 'ok' };
  });

  /* ---------- channel and people management (staff) ---------- */
  window.chCreateChannel = wrap("Couldn't create that channel.", async function (name, memberIds) {
    var n = String(name == null ? '' : name).trim();
    if (!n) throw Fail('Give the channel a name.');
    if (n.length > 80) throw Fail('Keep the channel name under 80 characters.');
    var s = need(client()), uid = await myId();
    var row = check(await s.from('channels').insert({ name: n, kind: 'team', created_by: uid }).select('id,name,kind,client_id,archived_at,created_at').single(), "Couldn't create that channel.");
    var made = { id: row.id, name: row.name, kind: row.kind, clientId: row.client_id || null, archived: false, lastMessageAt: null, unread: 0 };
    /* Three writes, not one, and in this order on purpose. Creating a channel is
       not one statement: the row goes in, then the people. If the people go in
       as a single insert and that insert fails, the channel exists with NOBODY
       in it — and my_channels() lists a channel by membership, so it is in
       nobody's list, cannot be opened, cannot be renamed or archived, and its
       name is taken. The old message said "add them from the channel's people
       list"; there was no channel to open to get to that list.
       So the creator's own seat goes in first and on its own. After that the
       channel is always one he can see, and a failure adding the others is
       something he can finish by hand. */
    var mine = await s.from('channel_members').insert({ channel_id: row.id, user_id: uid, member_role: 'owner' });
    if (mine && mine.error) throw Fail("The channel was made but could not be opened, so nothing was added to it. Try again, or ask for it to be cleared up.");
    var others = [];
    (memberIds || []).forEach(function (m) { if (m && m !== uid && others.indexOf(m) < 0) others.push(m); });
    if (others.length) {
      var mres = await s.from('channel_members').insert(others.map(function (m) { return { channel_id: row.id, user_id: m }; }));
      if (mres && mres.error) { var e = Fail("The channel was created and is yours, but some people couldn't be added. Add them from the channel's Members list."); e.partial = made; return Promise.reject(e); }
    }
    return made;
  });

  function staffUpdate(fallback, deniedMsg, patchFn) {
    return wrap(fallback, async function (id, value) {
      if (!id) throw Fail('Pick a channel first.');
      var rows = check(await need(client()).from('channels').update(patchFn(value)).eq('id', id).select('id,name,archived_at'), fallback);
      if (!rows || !rows.length) throw Fail(deniedMsg);
      return { id: rows[0].id, name: rows[0].name, archived: !!rows[0].archived_at };
    });
  }
  window.chRename = staffUpdate("Couldn't rename that channel.", 'Only Aviance staff can rename a channel.', function (name) {
    var n = String(name == null ? '' : name).trim();
    if (!n) throw Fail('Give the channel a name.');
    if (n.length > 80) throw Fail('Keep the channel name under 80 characters.');
    return { name: n };
  });
  // chArchive(id) archives; chArchive(id, false) brings it back.
  window.chArchive = staffUpdate("Couldn't archive that channel.", 'Only Aviance staff can archive a channel.', function (on) {
    return { archived_at: on === false ? null : new Date().toISOString() };
  });

  window.chAddMember = wrap("Couldn't add that person.", async function (id, userId) {
    if (!id || !userId) throw Fail('Pick a channel and a person first.');
    var res = await need(client()).from('channel_members').insert({ channel_id: id, user_id: userId });
    if (res && res.error && String(res.error.code) !== '23505') check(res, "Couldn't add that person.");   // already a member is fine
    return { channelId: id, userId: userId };
  });

  window.chRemoveMember = wrap("Couldn't remove that person.", async function (id, userId) {
    if (!id || !userId) throw Fail('Pick a channel and a person first.');
    check(await need(client()).from('channel_members').delete().eq('channel_id', id).eq('user_id', userId), "Couldn't remove that person.");
    return { channelId: id, userId: userId };
  });

  // Team logins and client people. userId is the login id or the client person id; kind says which.
  window.chMembers = wrap("Couldn't load the people in this channel.", async function (id) {
    if (!id) throw Fail('Pick a channel first.');
    var rows = check(await need(client()).from('channel_members').select('user_id,person_id,member_role,added_at,last_read_at').eq('channel_id', id), "Couldn't load the people in this channel.") || [];
    await loadNames(rows.map(function (r) { return r.user_id || r.person_id; }));
    return rows.map(function (r) {
      var mid = r.user_id || r.person_id, isClient = !r.user_id && !!r.person_id, p = names.get(mid) || {};
      return { userId: mid, kind: isClient ? 'client' : 'team', isClient: isClient, name: labelOf(mid, isClient), role: r.member_role || 'member', profileRole: isClient ? 'client' : (p.role || null), addedAt: r.added_at, lastReadAt: r.last_read_at };
    }).sort(function (a, b) { return (a.isClient === b.isClient ? 0 : a.isClient ? 1 : -1) || a.name.localeCompare(b.name); });
  });

  window.chEnsureClientChannel = wrap("Couldn't set up that client's channel.", async function (clientId, name) {
    var cid = String(clientId == null ? '' : clientId).trim();
    if (!cid) throw Fail('Pick a client first.');
    var id = check(await need(client()).rpc('ensure_client_channel', { p_client_id: cid, p_name: String(name || cid) }), "Couldn't set up that client's channel.");
    if (!id) throw Fail("Couldn't set up that client's channel.");
    return id;
  });

  /* ---------- the bot's drafts for one channel (team only; 20261124_journey_core.sql) ----------
     chBotDrafts(channelId) -> [{id, kind, body, reason, createdAt}] (pending, oldest first)
     chBotSend(draftId, body) -> {messageId}     chBotDiscard(draftId) -> {id}
     Nothing reaches the client until chBotSend. */
  window.chBotDrafts = wrap("The bot's drafts didn't load.", async function (channelId) {
    if (!channelId) return [];
    var list = check(await need(client()).rpc('drafts_pending'), "The bot's drafts didn't load.") || [];
    return (Array.isArray(list) ? list : []).filter(function (d) { return d && d.id && d.channel_id === channelId; })
      .map(function (d) { return { id: d.id, kind: d.kind || 'reply', body: d.body || '', reason: d.reason || '', msgKind: d.msg_kind || 'bot', createdAt: d.created_at || null }; })
      .sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); });
  });
  window.chBotSend = wrap("That didn't send. Try again.", async function (draftId, body) {
    var b = String(body == null ? '' : body).trim();
    if (!draftId) throw Fail('Pick a draft first.');
    if (!b) throw Fail('The message is empty. Write something or discard it.');
    if (b.length > MAX_BODY) throw Fail('That message is too long. Keep it under ' + MAX_BODY + ' characters.');
    var out = check(await need(client()).rpc('draft_send', { p_draft: draftId, p_body: b }), "That didn't send. Try again.");
    return { messageId: (out && (out.message_id || out.messageId)) || null };
  });
  window.chBotDiscard = wrap("That draft wasn't discarded. Try again.", async function (draftId) {
    if (!draftId) throw Fail('Pick a draft first.');
    check(await need(client()).rpc('draft_discard', { p_draft: draftId }), "That draft wasn't discarded. Try again.");
    return { id: draftId };
  });

  /* Names are cached for the page's life; sign-out reloads the page. Exposed for tests only. */
  window.chTestReset = function () { names.clear(); typingSent.clear(); typingChans.clear(); };
})();
