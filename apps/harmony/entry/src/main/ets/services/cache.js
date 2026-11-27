import relationalStore from '@ohos.data.relationalStore';

// Keep reads, writes and revocation in issue order. Small UTF-16 slices keep
// large message pages below a native ResultSet row's size limit.
export async function openCache(context) {
  const db = await relationalStore.getRdbStore(context, {
    name: 'task_history.db', securityLevel: relationalStore.SecurityLevel.S3, encrypt: true
  });
  await db.executeSql('CREATE TABLE IF NOT EXISTS entries (account TEXT, host TEXT, task TEXT, name TEXT, part INTEGER, body TEXT, PRIMARY KEY(account,host,task,name,part))');
  await db.executeSql("CREATE INDEX IF NOT EXISTS companion_avatar_cache ON entries(account, host, task) WHERE name='companion-avatar'");
  let previous = Promise.resolve();
  function enqueue(action) {
    const result = previous.then(action);
    previous = result.catch(() => {});
    return result;
  }
  return {
    read(key) {
      return enqueue(async () => {
        const rows = await db.querySql('SELECT body FROM entries WHERE account=? AND host=? AND task=? AND name=? ORDER BY part', key);
        try {
          let json = '';
          while (rows.goToNextRow()) json += rows.getString(0);
          return json ? JSON.parse(json) : null;
        } finally { rows.close(); }
      });
    },
    draftTasks(account, host) {
      return enqueue(async () => {
        const rows = await db.querySql("SELECT DISTINCT task FROM entries WHERE account=? AND host=? AND task<>'' AND part=0 AND (name='attachments' OR (name='draft' AND trim(body, ' ' || char(34))<>''))", [account, host]);
        const drafts = new Set();
        try { while (rows.goToNextRow()) drafts.add(rows.getString(0)); }
        finally { rows.close(); }
        return drafts;
      });
    },
    write(key, value) {
      const json = value == null ? '' : JSON.stringify(value);
      return enqueue(async () => {
        db.beginTransaction();
        try {
          await db.executeSql('DELETE FROM entries WHERE account=? AND host=? AND task=? AND name=?', key);
          let offset = 0, part = 0;
          while (offset < json.length) {
            let end = Math.min(json.length, offset + 16000);
            if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
            await db.executeSql('INSERT INTO entries VALUES (?,?,?,?,?,?)', [...key, part++, json.slice(offset, end)]);
            offset = end;
          }
          if (key[3] === 'companion-avatar' && json) {
            // 2,048 chunks of at most 16,000 ASCII bytes keep photos under 32 MiB.
            // Count indexed chunks without scanning image bytes or evicting task data.
            await db.executeSql(`DELETE FROM entries WHERE name='companion-avatar' AND (account,host,task) IN (
              SELECT account,host,task FROM (
                SELECT account,host,task, SUM(COUNT(*)) OVER (ORDER BY MAX(rowid) DESC) AS cumulative
                FROM entries WHERE name='companion-avatar' GROUP BY account,host,task
              ) WHERE cumulative > 2048
            )`);
          }
          db.commit();
        } catch (error) { db.rollBack(); throw error; }
      });
    },
    forget(account, host) {
      return enqueue(() => host
        ? db.executeSql('DELETE FROM entries WHERE account=? AND host=?', [account, host])
        : db.executeSql('DELETE FROM entries WHERE account=?', [account]));
    }
  };
}
