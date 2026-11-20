const RaceDraw = (() => {
  const highPool = [
    'PithyFan9168', 'KIT Tgsbxajs', 'Autright', 'LemonDuck5254', 'R97 Blake',
    'Y1HCX', 'yanyuan6530', 'mang guo4731', 'WorryingApple40'
  ];
  const cleanName = name => name.trim().replace(/(?:\s*[、，,；;])+$/u, '').trimEnd();
  const normalizedName = name => cleanName(name).replace(/\s+/g, '').toLowerCase();
  const highKeys = new Set(highPool.map(normalizedName));
  function playerKey(name) {
    const compact = normalizedName(name).normalize('NFKC').replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '');
    // Decorations around or within a high-pool nickname don't change that player's identity.
    for (const key of highKeys) {
      if (compact.includes(key)) return key;
    }
    return normalizedName(name);
  }
  const cannotSolo = new Set(['yanyuan6530', 'mang guo4731'].map(playerKey));
  const isHigh = name => highKeys.has(playerKey(name));
  const pairKey = (a, b) => JSON.stringify([a, b].sort());
  const storageKey = 'horizon-elbow-race.pairs.v1';
  const windowMs = 12 * 60 * 60 * 1000;
  const sample = new Uint32Array(1);
  const currentTabHistory = new Map();

  function randomIndex(length) {
    const range = 2 ** 32;
    const cutoff = range - range % length;
    do {
      crypto.getRandomValues(sample);
    } while (sample[0] >= cutoff);
    return sample[0] % length;
  }

  function shuffled(items) {
    const order = [...items];
    for (let i = order.length - 1; i > 0; i--) {
      const j = randomIndex(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  function eligibleSolo(names, highCount, lowCount) {
    return names.filter(name => {
      if (cannotSolo.has(playerKey(name))) return false;
      return isHigh(name) ? highCount - 1 <= lowCount : highCount <= lowCount - 1;
    });
  }

  function readHistory(now) {
    const entries = new Map(currentTabHistory);
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (Array.isArray(stored)) {
        for (const record of stored) {
          if (!Array.isArray(record) || record.length !== 3) continue;
          const [a, b, time] = record;
          if (typeof a !== 'string' || typeof b !== 'string' || !Number.isFinite(time)) continue;
          const aKey = playerKey(a);
          const bKey = playerKey(b);
          if (!aKey || !bKey || aKey === bKey) continue;
          const key = pairKey(aKey, bKey);
          if (!entries.has(key) || entries.get(key)[2] < time) entries.set(key, [aKey, bKey, time]);
        }
      }
    } catch {
      // Private or restricted browser sessions can still track matches in this tab.
    }

    for (const [key, record] of entries) {
      if (record[2] <= now - windowMs) entries.delete(key);
    }
    return entries;
  }

  function writeHistory(history) {
    currentTabHistory.clear();
    for (const [key, record] of history) currentTabHistory.set(key, record);
    try {
      if (history.size) localStorage.setItem(storageKey, JSON.stringify([...history.values()]));
      else localStorage.removeItem(storageKey);
      return true;
    } catch {
      return false;
    }
  }

  // Edmonds' matching algorithm. Odd cycles are contracted so low-pool pairs
  // can be considered alongside high/low pairs without getting stuck greedily.
  function perfectMatching(graph) {
    const size = graph.length;
    const match = Array(size).fill(-1);

    function extend(root) {
      const parent = Array(size).fill(-1);
      const base = Array.from({length: size}, (_, i) => i);
      const queued = Array(size).fill(false);
      const queue = [root];
      queued[root] = true;

      function commonBase(a, b) {
        const path = new Set();
        while (true) {
          a = base[a];
          path.add(a);
          if (match[a] === -1) break;
          a = parent[match[a]];
        }
        while (!path.has(base[b])) b = parent[match[base[b]]];
        return base[b];
      }

      function markCycle(vertex, common, child, cycle) {
        while (base[vertex] !== common) {
          const partner = match[vertex];
          cycle[base[vertex]] = cycle[base[partner]] = true;
          parent[vertex] = child;
          child = partner;
          vertex = parent[partner];
        }
      }

      for (let head = 0; head < queue.length; head++) {
        const vertex = queue[head];
        for (const next of graph[vertex]) {
          if (base[vertex] === base[next] || match[vertex] === next) continue;
          if (next === root || (match[next] !== -1 && parent[match[next]] !== -1)) {
            const common = commonBase(vertex, next);
            const cycle = Array(size).fill(false);
            markCycle(vertex, common, next, cycle);
            markCycle(next, common, vertex, cycle);
            for (let i = 0; i < size; i++) {
              if (!cycle[base[i]]) continue;
              base[i] = common;
              if (!queued[i]) {
                queued[i] = true;
                queue.push(i);
              }
            }
          } else if (parent[next] === -1) {
            parent[next] = vertex;
            if (match[next] === -1) {
              let end = next;
              while (end !== -1) {
                const previous = parent[end];
                const following = match[previous];
                match[end] = previous;
                match[previous] = end;
                end = following;
              }
              return;
            }
            const partner = match[next];
            queued[partner] = true;
            queue.push(partner);
          }
        }
      }
    }

    for (let i = 0; i < size; i++) {
      if (match[i] === -1) extend(i);
    }
    return match.includes(-1) ? null : match;
  }

  function matchRoster(names, history) {
    const players = shuffled(names);
    const keys = players.map(playerKey);
    const graph = players.map(() => []);
    const repeats = [];
    const addEdge = (a, b) => {
      graph[a].push(b);
      graph[b].push(a);
    };

    for (let a = 0; a < players.length; a++) {
      for (let b = a + 1; b < players.length; b++) {
        if (highKeys.has(keys[a]) && highKeys.has(keys[b])) continue;
        const previous = history.get(pairKey(keys[a], keys[b]));
        if (previous) repeats.push({a, b, time: previous[2]});
        else addEdge(a, b);
      }
    }

    let matches = perfectMatching(graph);
    // If fresh pairs alone cannot work, allow the oldest previous pairings first.
    if (!matches) {
      repeats.sort((a, b) => a.time - b.time);
      for (const {a, b} of repeats) {
        addEdge(a, b);
        matches = perfectMatching(graph);
        if (matches) break;
      }
    }
    if (!matches) throw new Error('No valid matching after roster validation');

    const pairs = [];
    for (let i = 0; i < players.length; i++) {
      if (matches[i] < i) continue;
      const a = players[i];
      const partner = matches[i];
      const b = players[partner];
      const previous = history.get(pairKey(keys[i], keys[partner]));
      const swap = previous ? previous[0] === keys[i] : randomIndex(2) === 1;
      pairs.push({a: swap ? b : a, b: swap ? a : b, repeated: Boolean(previous)});
    }
    return shuffled(pairs);
  }

  function draw(names, now = Date.now()) {
    const highCount = names.filter(isHigh).length;
    const lowCount = names.length - highCount;
    let solo = null;
    if (names.length % 2) {
      const eligible = eligibleSolo(names, highCount, lowCount);
      if (!eligible.length) {
        const error = highCount - 1 > lowCount
          ? '低池人数不足，无法避免两名高池玩家同组。请增加低池玩家或调整名单。'
          : '没有符合条件的 S1 自由人。请调整名单后再抽签。';
        return {error};
      }
      solo = eligible[randomIndex(eligible.length)];
    } else if (highCount > lowCount) {
      return {error: '低池人数不足，无法避免两名高池玩家同组。请增加低池玩家或调整名单。'};
    }
    const history = readHistory(now);
    const pairs = matchRoster(names.filter(name => name !== solo), history);
    for (const {a, b} of pairs) {
      const aKey = playerKey(a);
      const bKey = playerKey(b);
      history.set(pairKey(aKey, bKey), [aKey, bKey, now]);
    }
    const persisted = writeHistory(history);
    return {pairs, solo, persisted};
  }

  writeHistory(readHistory(Date.now()));
  return {draw, highPool, playerKey, cleanName};
})();
