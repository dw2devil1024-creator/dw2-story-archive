import { MODULE, DEFAULT_CROP, fileStem, aliasKey, bounded, timestamp, normalizeRows, mergeDetails, displayChatName, entitiesFromContext, isFavorite, isPinned, filterEntities, SORT_OPTIONS, normalizeSort, createArchiveCache, switchNativeChat, createNativeChat, deleteNativeChat, selectedEntityMatches } from './core.js';
import { pageSize, pageWindow, filterFolder, attachOrganizer, shelfView, rememberShelfView } from './organizer.js';
import { BOOKSHELF_VERSION, createVersionManager } from './versions.js';
import { openVersionDialog } from './version-ui.js';
import { attachHomeLayout } from './layout.js';

const appRoot = new URL('../../../../', import.meta.url);
const nativeModuleURL = import.meta.url;
const ctx = () => globalThis.SillyTavern.getContext();
const url = path => new URL(path, appRoot).href;
const shells = new Set();
const listeners = [];
const requests = new Set();
const counts = new Map();
const pendingCounts = new Map();
const fileCache = createArchiveCache();
const detailCache = createArchiveCache();
const queue = [];
let activeJobs = 0;
let enabledRuntime = false;
let opening = false;
let dismissedHome = false;
let observer;
let frame;
let welcomeModule;
let coreModule;
let groupModule;
let rootHome;
let cardsRevision = 0;
let dialogId = 0;
let characterIndex;
let characterSource;
let characterLength = -1;
let characterRevision = -1;
let versionManager;

function settings() {
    const store = ctx().extensionSettings;
    if (!store[MODULE] || typeof store[MODULE] !== 'object') store[MODULE] = {};
    const s = store[MODULE];
    if (typeof s.enabled !== 'boolean') s.enabled = true;
    for (const key of ['favorites', 'aliases', 'crops', 'covers']) if (!s[key] || typeof s[key] !== 'object' || Array.isArray(s[key])) s[key] = {};
    if (!Array.isArray(s.pinned)) s.pinned = [];
    if (!Array.isArray(s.customOrder)) s.customOrder = [];
    s.customOrder = [...new Set(s.customOrder.filter(key => typeof key === 'string' && key))];
    s.sort = normalizeSort(s.sort);
    s.pageSize = pageSize(s.pageSize);
    return s;
}
function save() { ctx().saveSettingsDebounced(); }
function element(tag, className = '', text = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
}
function button(text, className, click, title) {
    const el = element('button', className, text); el.type = 'button';
    if (text === '⌖' || className.split(' ').includes('jd-pin')) {
        el.textContent = '';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
        svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5'); svg.setAttribute('stroke-linecap', 'round');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', text === '⌖'
            ? 'M6 3v12a3 3 0 0 0 3 3h12M3 6h12a3 3 0 0 1 3 3v12'
            : 'M9 3h6v6l3 4v2H6v-2l3-4V3M12 15v6');
        svg.append(path); el.append(svg);
    }
    if (title) { el.title = title; el.setAttribute('aria-label', title); }
    if (click) el.addEventListener('click', click);
    return el;
}
function report(message) {
    for (const shell of shells) shell.notice.textContent = message;
    const top = [...document.querySelectorAll('.jd-shelf-dialog[open] .jd-shelf-notice')].at(-1);
    if (top) top.textContent = message;
    if (globalThis.toastr && message) globalThis.toastr.info(message, 'DW2 · Story Archive');
}
function flashShelfNotice(shell, message, delay = 2200) {
    if (!shell?.notice) return;
    clearTimeout(shell.noticeTimer);
    shell.notice.textContent = message;
    shell.noticeTimer = setTimeout(() => {
        if (shell.notice.textContent === message) shell.notice.textContent = '';
        shell.noticeTimer = null;
    }, delay);
}
const loadWelcome = () => welcomeModule ||= import(new URL('scripts/welcome-screen.js', appRoot).href);
const loadCore = () => coreModule ||= import(new URL('script.js', appRoot).href);
const loadGroups = () => groupModule ||= import(new URL('scripts/group-chats.js', appRoot).href);

async function saveConfirmedSettings() {
    const api = await loadCore(), context = ctx(), types = context.eventTypes || context.event_types;
    if (!api.saveSettings || !types.SETTINGS_UPDATED) throw new Error('当前酒馆无法确认设置已保存，请先更新酒馆。');
    let acknowledged = false;
    const confirmed = () => { acknowledged = true; };
    context.eventSource.on(types.SETTINGS_UPDATED, confirmed);
    try {
        await api.saveSettings();
        if (!acknowledged) throw new Error('书架设置尚未保存成功，已停止操作。请检查酒馆连接。');
    } finally {
        context.eventSource.removeListener ? context.eventSource.removeListener(types.SETTINGS_UPDATED, confirmed) : context.eventSource.off(types.SETTINGS_UPDATED, confirmed);
    }
}
async function prepareVersionChange() {
    const [api, groups] = await Promise.all([loadCore(), loadGroups()]);
    if (opening || api.is_send_press || api.isChatSaving || groups.is_group_generating) throw new Error('酒馆正在生成、打开或保存聊天，请结束后再切换版本。');
    if (hasSelection() && ctx().chat?.length) {
        if (!ctx().saveChat) throw new Error('请先返回酒馆首页，再切换版本。');
        await ctx().saveChat();
    }
}
function showVersionManager() {
    versionManager ||= createVersionManager({
        settings, save, flush: saveConfirmedSettings, context: ctx, apiRoot: appRoot,
        moduleURL: nativeModuleURL,
        helperId: globalThis[Symbol.for('jingdu.bookshelf.helper.runtime')]?.scriptId,
        beforeChange: prepareVersionChange,
    });
    openVersionDialog({ manager: versionManager, element, button, dialog, currentVersion: BOOKSHELF_VERSION,
        notify: report, refresh: async () => { await prepareVersionChange(); await saveConfirmedSettings(); location.reload(); } });
}

function assistantAvatar() {
    const chosen = ctx().accountStorage?.getItem('assistant');
    return chosen && ctx().characters?.some(c => c.avatar === chosen) ? chosen : 'default_Assistant.png';
}
function charFor(entity) {
    const source = ctx().characters || [];
    if (source !== characterSource || source.length !== characterLength || characterRevision !== cardsRevision) {
        characterSource = source; characterLength = source.length; characterRevision = cardsRevision;
        characterIndex = new Map(source.filter(Boolean).map(c => [c.avatar, c]));
    }
    return characterIndex.get(entity.id);
}
function groupFor(entity) { return (ctx().groups || []).find(g => String(g.id) === entity.id); }
function entityForKey(key) {
    // Re-read live entities after deletion; cached cards may have become stale.
    return entitiesFromContext(ctx(), assistantAvatar()).find(entity => entity.key === key) || null;
}

async function request(path, body) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(url(path), { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body), signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('读取存档超时，可以稍后重试');
        throw error;
    } finally { clearTimeout(timeout); requests.delete(controller); }
}

async function readFiles(entity) {
    if (entity.kind === 'assistant') return [];
    if (entity.kind === 'group') {
        const group = groupFor(entity);
        if (!group) throw new Error('这个群聊已不在角色列表中，请刷新书架');
        return [...new Set(group.chats || [])].map(name => ({ name: fileStem(name), date: 0, messages: null }));
    }
    const character = charFor(entity);
    if (!character) throw new Error('这张角色卡已被移动或改名，请刷新书架');
    const data = await request('api/characters/chats', { avatar_url: entity.id, simple: true });
    // Native 1.18.0 returns {error:true} when a new character has no chat folder.
    // Accept it only when native character metadata independently says no chats.
    if (data?.error === true && character.chat_size === 0 && !timestamp(character.date_last_chat)) return [];
    return normalizeRows(data);
}
async function readDetails(entity, files) {
    const data = entity.kind === 'group'
        ? await request('api/chats/search', { group_id: groupFor(entity)?.id ?? entity.id, query: '' })
        : await request('api/characters/chats', { avatar_url: entity.id });
    return mergeDetails(files, normalizeRows(data));
}

async function readDeletionFiles(entity) {
    if (entity.kind !== 'group') return readFiles(entity);
    const groups = await request('api/groups/all', {});
    if (!Array.isArray(groups)) throw new Error('群聊列表暂未读取');
    const remote = groups.find(g => String(g.id) === String(entity.id));
    const local = groupFor(entity);
    if (!remote || !local || !Array.isArray(remote.chats)) throw new Error('群聊已不存在，请刷新书架');
    local.chats = [...remote.chats]; local.chat_id = remote.chat_id;
    return [...new Set(remote.chats)].map(name => ({ name: fileStem(name), date: 0, messages: null }));
}

function invalidateArchiveData() {
    cardsRevision++; counts.clear(); fileCache.clear(); detailCache.clear();
}
function getFiles(entity, options) {
    return fileCache.load(entity.key, () => readFiles(entity), options);
}
function getDetails(entity, files) {
    return detailCache.load(entity.key, () => readDetails(entity, files)).then(details => mergeDetails(files, details));
}

function pump() {
    while (activeJobs < 3 && queue.length) {
        const task = queue.shift(); activeJobs++;
        task().finally(() => { activeJobs--; pump(); });
    }
}
function loadCount(entity, force = false) {
    if (!force && counts.has(entity.key)) return Promise.resolve(counts.get(entity.key));
    const revision = cardsRevision;
    const jobKey = `${revision}:${entity.key}`;
    if (pendingCounts.has(jobKey)) return pendingCounts.get(jobKey);
    const result = new Promise(resolve => {
        queue.push(async () => {
            let value = null;
            const needed = [...shells].some(view => view.visible.has(entity.key) || (normalizeSort(settings().sort) === 'count' && view.countTargets?.has(entity.key)));
            if (revision !== cardsRevision || !enabledRuntime || !needed) { pendingCounts.delete(jobKey); resolve(undefined); return; }
            try { value = (await getFiles(entity)).length; if (revision === cardsRevision) counts.set(entity.key, value); }
            catch { if (revision === cardsRevision) counts.set(entity.key, null); /* Unknown is not zero. */ }
            finally { pendingCounts.delete(jobKey); resolve(revision === cardsRevision ? value : undefined); }
        });
    });
    pendingCounts.set(jobKey, result); pump(); return result;
}

function dateLabel(value, relative = true) {
    const time = timestamp(value);
    if (!time) return '尚未游玩';
    const date = new Date(time);
    const delta = Date.now() - time;
    if (relative && delta >= 0 && delta < 86400000) {
        if (delta < 60000) return '刚刚玩过';
        if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
        return `${Math.floor(delta / 3600000)} 小时前`;
    }
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', ...(relative ? {} : { hour: '2-digit', minute: '2-digit' }) }).format(date);
}
function nativeImageSource(entity) {
    if (entity.kind === 'char') return entity.id && entity.id !== 'none' ? url(`characters/${encodeURIComponent(entity.id)}`) : '';
    if (entity.kind === 'group' && typeof entity.avatar === 'string' && entity.avatar !== 'none') {
        try { const parsed = new URL(entity.avatar, appRoot); if (['http:', 'https:'].includes(parsed.protocol) || entity.avatar.startsWith('data:image/')) return parsed.href; } catch {}
    }
    return '';
}
function customCoverPath(entity) {
    const path = settings().covers?.[entity.key];
    return typeof path === 'string' && path.trim() ? path.trim() : '';
}
function imageSource(entity) {
    const custom = customCoverPath(entity);
    return custom ? url(custom) : nativeImageSource(entity);
}
const coverRatioCache = new Map();
const coverRatioPending = new Map();
function zoomValue(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(100, Math.min(200, numeric)) : 100;
}
function cropValues(entity) {
    const crop = settings().crops[entity.key] || DEFAULT_CROP;
    return { x: bounded(crop.x, 50), y: bounded(crop.y, 25), zoom: zoomValue(crop.zoom) };
}
function cropFor(entity) {
    const crop = cropValues(entity);
    return `${crop.x}% ${crop.y}%`;
}
function coverURL(entity, source, native = false) {
    if (!source) return '';
    return native && entity.kind === 'char'
        ? `${source}${source.includes('?') ? '&' : '?'}dw2=${cardsRevision}`
        : source;
}
function coverRatio(source) {
    if (coverRatioCache.has(source)) return Promise.resolve(coverRatioCache.get(source));
    if (coverRatioPending.has(source)) return coverRatioPending.get(source);
    const pending = new Promise(resolve => {
        const probe = new Image();
        probe.onload = () => resolve(probe.naturalWidth && probe.naturalHeight ? probe.naturalWidth / probe.naturalHeight : 0.75);
        probe.onerror = () => resolve(0.75);
        probe.src = source;
    }).then(ratio => {
        coverRatioCache.set(source, ratio);
        coverRatioPending.delete(source);
        return ratio;
    });
    coverRatioPending.set(source, pending);
    return pending;
}
function applyCoverFrame(art, source, values) {
    const x = bounded(values?.x, 50), y = bounded(values?.y, 25), zoom = zoomValue(values?.zoom);
    art.dataset.coverSource = source;
    art.dataset.coverZoom = String(zoom);
    art.style.setProperty('background-position', `${x}% ${y}%`, 'important');
    art.style.setProperty('background-size', 'cover', 'important');
    void coverRatio(source).then(ratio => {
        if (!art.isConnected || art.dataset.coverSource !== source) return;
        const liveZoom = zoomValue(art.dataset.coverZoom);
        const box = art.parentElement;
        const boxRatio = box?.clientWidth && box?.clientHeight ? box.clientWidth / box.clientHeight : 0.75;
        const size = ratio >= boxRatio ? `auto ${liveZoom}%` : `${liveZoom}% auto`;
        art.style.setProperty('background-size', size, 'important');
    });
}
function cover(entity, className = 'jd-cover') {
    const box = element('div', className);
    const fallback = element('span', 'jd-cover-letter', entity.assistant ? 'ST' : [...entity.name][0] || '书');
    fallback.setAttribute('aria-hidden', 'true'); box.append(fallback);

    const custom = customCoverPath(entity);
    const primary = custom ? url(custom) : nativeImageSource(entity);
    const native = custom ? nativeImageSource(entity) : '';
    if (primary) {
        const art = element('div', 'jd-cover-art');
        art.setAttribute('aria-hidden', 'true');
        const layers = [
            coverURL(entity, primary, !custom),
            coverURL(entity, native, true),
        ].filter(Boolean);
        art.style.setProperty('background-image', layers.map(source => `url(${JSON.stringify(source)})`).join(', '), 'important');
        art.style.setProperty('background-repeat', 'no-repeat', 'important');
        box.append(art);
        applyCoverFrame(art, primary, cropValues(entity));
    }
    return box;
}

function dialog(title, wide = false) {
    const modal = element('dialog', `jd-shelf-dialog${wide ? ' jd-shelf-wide' : ''}`);
    const head = element('header', 'jd-dialog-head');
    const heading = element('h2', '', title); heading.id = `jd-heading-${++dialogId}`;
    modal.setAttribute('aria-labelledby', heading.id);
    const close = button('×', 'jd-icon-button', () => modal.close(), '关闭');
    head.append(heading, close);
    const body = element('div', 'jd-dialog-body');
    const notice = element('p', 'jd-shelf-notice'); notice.setAttribute('role', 'status');
    modal.append(head, body, notice); document.body.append(modal);
    const priorFocus = document.activeElement;
    modal.addEventListener('close', () => { modal.remove(); if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true }); });
    modal.addEventListener('click', event => {
        if (event.target !== modal) return;
        const rect = modal.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) modal.close();
    });
    modal.showModal();
    return { modal, body, notice };
}

function setBusy(value) {
    opening = value;
    document.querySelectorAll('.jd-open-card,.jd-open-chat,.jd-open-native,.jd-new-chat,.jd-delete-chat,.jd-edit-alias,.jd-add-character,.jd-delete-character,.jd-set-shelf-cover,.jd-reset-shelf-cover,#jd-bookshelf-settings button').forEach(el => { el.disabled = value; });
    document.getElementById('jd-bookshelf-open')?.setAttribute('aria-disabled', String(value));
}
async function safeAction(action) {
    if (opening) return;
    for (const shell of shells) shell.notice.textContent = '';
    document.querySelectorAll('.jd-shelf-dialog .jd-shelf-notice').forEach(el => { el.textContent = ''; });
    setBusy(true);
    try { await action(); }
    catch (error) { console.warn('[DW2 Story Archive]', error); report(error.message || '暂时未能打开，请重试或使用原生入口'); }
    finally { setBusy(false); }
}

// Always call the native selectors, which own saving, metadata, lore bindings,
// regex activation and CHAT_CHANGED notifications used by other extensions.
async function openNative(entity, filename = null) {
    await switchNativeChat({ context: ctx, entity, filename, api: await loadCore(), groups: await loadGroups(), openAssistant: async () => (await loadWelcome()).openPermanentAssistantChat() });
    document.querySelectorAll('.jd-shelf-dialog[open]').forEach(d => d.close());
    unmountHome(); invalidateArchiveData();
}

function choose(entity) {
    if (opening) return;
    if (entity.kind === 'assistant') return safeAction(() => openNative(entity));
    showArchives(entity, fileCache.peek(entity.key));
}
async function newChat(entity) {
    const revision = cardsRevision;
    const files = await getFiles(entity, { fresh: true });
    if (!enabledRuntime || revision !== cardsRevision) throw new Error('聊天或角色列表已经变化，请重新选择。');
    // Selecting a never-played character already creates its first greeting.
    // Reuse that new story instead of saving it and making a second empty file.
    if (!files.length && !selectedEntityMatches(ctx(), entity)) return openNative(entity);
    await createNativeChat({ context: ctx, entity, api: await loadCore(), groups: await loadGroups(), openAssistant: async () => (await loadWelcome()).openPermanentAssistantChat() });
    document.querySelectorAll('.jd-shelf-dialog[open]').forEach(d => d.close());
    unmountHome(); invalidateArchiveData();
}

function updateCounts(key, count) {
    if (count === undefined) return;
    for (const shell of shells) {
        const item = shell.visible.get(key);
        if (!item) continue;
        const badge = item.querySelector('.jd-save-count');
        if (badge) badge.textContent = count === null ? '查看存档' : count ? `${count} 个存档` : '开始新故事';
        const action = item.querySelector('.jd-card-action');
        if (action) action.textContent = '查看存档 ↗';
    }
}

function showArchives(entity, cached, successMessage = '') {
    const existing = [...document.querySelectorAll('.jd-archives-dialog[open]')].find(d => d.dataset.entity === entity.key);
    if (existing) { existing.querySelector('.jd-dialog-head button')?.focus(); return; }
    const { modal, body, notice } = dialog(entity.name);
    modal.classList.add('jd-archives-dialog'); modal.dataset.entity = entity.key;
    const successNotice = successMessage ? `✓ ${successMessage}` : '';
    if (successNotice) {
        notice.textContent = successNotice;
        const timer = setTimeout(() => {
            if (notice.textContent === successNotice) notice.textContent = '';
        }, 3200);
        modal.addEventListener('close', () => clearTimeout(timer), { once: true });
    }
    const revision = cardsRevision;
    const current = () => enabledRuntime && revision === cardsRevision && modal.isConnected && modal.open;
    const top = element('div', 'jd-archive-toolbar');
    const sub = element('p', 'jd-dialog-intro', '正在读取存档…');
    const add = button('＋ 新聊天', 'jd-text-button jd-new-chat', () => {
        safeAction(() => newChat(entity));
    }, `为${entity.name}新建聊天`);
    add.disabled = opening;
    top.append(sub, add);
    const list = element('div', 'jd-save-list'); body.append(top, list);
    let rows = cached === undefined ? null : mergeDetails(cached, []);
    let detailsState = 'loading', requestId = 0;
    const draw = () => {
        const activeName = document.activeElement?.closest('.jd-save-row')?.dataset.filename;
        list.replaceChildren();
        sub.textContent = rows === null ? '正在读取存档…' : `${rows.length} 个存档 · 最近游玩的排在前面`;
        if (rows === null) { list.append(element('p', 'jd-loading', '正在读取存档列表，可以随时关闭。')); return; }
        if (!rows.length) list.append(element('p', 'jd-empty', '还没有存档，点「＋ 新聊天」开始。'));
        for (const row of rows) {
            const item = element('div', 'jd-save-row'); item.dataset.filename = row.name;
            const main = button('', 'jd-open-chat', () => {
                safeAction(async () => {
                    const latest = await getFiles(entity, { fresh: true });
                    if (!current()) return;
                    if (!latest.some(r => r.name === row.name)) {
                        rows = mergeDetails(latest, rows); counts.set(entity.key, rows.length); updateCounts(entity.key, rows.length); draw();
                        throw new Error('这份存档已被移动或改名，列表已刷新');
                    }
                    await openNative(entity, row.name);
                });
            });
            main.title = row.name; main.disabled = opening;
            const title = element('strong', '', displayChatName(entity, row, settings().aliases));
            const detail = element('small', '', [row.date ? dateLabel(row.date, false) : timestamp(row.name) ? dateLabel(timestamp(row.name), false) : '日期未知', row.messages == null ? '' : `${row.messages} 条消息`, row.size || ''].filter(Boolean).join(' · '));
            const previewText = row.preview || (detailsState === 'loading' ? '正在读取聊天片段…' : row.preview === '' ? '该条消息暂无可显示的正文。' : '聊天片段暂未读取，可直接打开存档。');
            const preview = element('span', `jd-save-preview${row.preview ? '' : ' jd-preview-empty'}`, previewText);
            if (row.preview) preview.title = row.preview;
            main.append(title, detail, preview);
            const tools = element('div', 'jd-save-tools');
            const edit = button('✎', 'jd-icon-button jd-edit-alias', () => editAlias(entity, row, draw), '修改显示名');
            const remove = button('', 'jd-icon-button jd-delete-chat', () => confirmDelete(entity, row, modal, current), '删除这份存档');
            const icon = element('i', 'fa-solid fa-trash-can'); icon.setAttribute('aria-hidden', 'true');
            remove.append(icon); edit.disabled = remove.disabled = opening;
            tools.append(edit, remove); item.append(main, tools); list.append(item);
            if (activeName === row.name) main.focus({ preventScroll: true });
        }
    };
    const load = async (fresh = false) => {
        const id = ++requestId;
        try {
            const files = await getFiles(entity, { fresh });
            if (!current() || id !== requestId) return;
            counts.set(entity.key, files.length); updateCounts(entity.key, files.length);
            rows = mergeDetails(files, rows || []); detailsState = 'loading';
            if (notice.textContent !== successNotice) notice.textContent = '';
            draw();
            if (!files.length) return;
            // Previews can be slow on long chats; filenames are already usable.
            getDetails(entity, files).then(details => {
                if (current() && id === requestId) { rows = details; detailsState = 'ready'; draw(); }
            }).catch(() => {
                if (current() && id === requestId) { detailsState = 'error'; draw(); notice.textContent = '聊天片段暂未读取，仍可直接打开存档，或点「刷新列表」重试。'; }
            });
        } catch (error) {
            if (current() && id === requestId) {
                sub.textContent = rows === null ? '存档列表暂未读取' : sub.textContent;
                if (rows === null) list.replaceChildren();
                notice.textContent = `${error.message || '读取失败'}，可点「刷新列表」重试。`;
            }
        }
    };
    const foot = element('div', 'jd-dialog-footer');
    foot.append(button('刷新列表', 'jd-text-button', () => { detailCache.clear(); load(true); }));
    foot.append(button('在原生界面管理存档', 'jd-text-button jd-open-native', () => {
        safeAction(async () => {
            await openNative(entity);
            const api = await loadCore();
            if (typeof api.displayPastChats === 'function') await api.displayPastChats();
        });
    }));
    if (entity.kind === 'char') {
        const remove = button('', 'jd-icon-button jd-delete-character', () => deleteCharacterFromShelf(entity, modal), `删除角色卡「${entity.name}」`);
        const icon = element('i', 'fa-solid fa-trash-can'); icon.setAttribute('aria-hidden', 'true');
        remove.append(icon); remove.disabled = opening; foot.append(remove);
    }
    body.append(foot); draw(); void load();
}

function confirmDelete(entity, row, archive, current) {
    if (opening || !current()) return;
    const { modal, body, notice } = dialog('删除这份存档？');
    modal.classList.add('jd-delete-dialog');
    const name = displayChatName(entity, row, settings().aliases);
    const label = element('strong', 'jd-delete-name', name);
    const info = element('p', 'jd-dialog-intro', [entity.name, row.date ? dateLabel(row.date, false) : '', row.messages == null ? '' : `${row.messages} 条消息`].filter(Boolean).join(' · '));
    body.append(label, info);
    if (name !== row.name) body.append(element('p', 'jd-delete-file', `原文件名：${row.name}`));
    body.append(element('p', 'jd-dialog-intro', '删除后无法在书架恢复。角色卡和其他存档会保留。'));
    const wasActive = selectedEntityMatches(ctx(), entity) && fileStem(ctx().getCurrentChatId()) === row.name;
    if (wasActive) body.append(element('p', 'jd-dialog-intro', '这是正在打开的存档，确认后会先退出当前聊天。'));
    const location = () => JSON.stringify([ctx().groupId ?? null, ctx().characters?.[ctx().characterId]?.avatar ?? null, ctx().getCurrentChatId() ?? null]);
    const originalLocation = location();
    let pending = false;
    const cancel = button('取消', 'jd-secondary-button', () => modal.close());
    const commit = button('删除存档', 'jd-primary-button jd-delete-confirm', async () => {
        if (pending || opening) return;
        pending = true; setBusy(true); notice.textContent = '';
        cancel.disabled = commit.disabled = true;
        const close = modal.querySelector('.jd-dialog-head button'); close.disabled = true;
        commit.textContent = '正在删除…';
        try {
            const result = await deleteNativeChat({ context: ctx, entity, filename: row.name, api: await loadCore(), groups: await loadGroups(), listFiles: readDeletionFiles, isCurrent: () => current() && modal.open, isEnabled: () => enabledRuntime });
            const s = settings(); delete s.aliases[aliasKey(entity.key, row.name)]; save();
            invalidateArchiveData(); counts.set(entity.key, result.files.length);
            for (const shell of shells) shell.draw(); updateCounts(entity.key, result.files.length);
            const samePlace = result.closedCurrent ? !hasSelection() : location() === originalLocation;
            if (enabledRuntime && samePlace) {
                const scrollTop = archive.scrollTop;
                modal.close(); archive.close();
                const next = entityForKey(entity.key);
                if (next) {
                    showArchives(next, result.files, '已删除这份存档。');
                    const updated = [...document.querySelectorAll('.jd-archives-dialog[open]')].find(d => d.dataset.entity === entity.key);
                    if (updated) updated.scrollTop = scrollTop;
                }
                // The archive dialog occupies the top layer; show success inside it.
                if (!next) globalThis.toastr?.success('已删除这份存档。', 'DW2 · Story Archive');
            }
        } catch (error) {
            const message = error.message || '删除未完成，请刷新列表检查';
            if (enabledRuntime) {
                if (!modal.isConnected && wasActive && !hasSelection()) {
                    const next = entityForKey(entity.key); if (next) showArchives(next);
                }
                report(message);
            }
        } finally {
            pending = false; setBusy(false); cancel.disabled = commit.disabled = close.disabled = false; commit.textContent = '删除存档';
        }
    });
    modal.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
    modal.addEventListener('click', event => { if (pending && event.target === modal) event.stopImmediatePropagation(); }, true);
    const actions = element('div', 'jd-delete-actions'); actions.append(cancel, commit); body.append(actions); cancel.focus();
}

async function deleteCharacterFromShelf(entity, archive) {
    if (opening || entity.kind !== 'char' || !archive?.open) return;
    let api, popupModule, templateModule;
    try {
        [api, popupModule, templateModule] = await Promise.all([
            loadCore(),
            import(new URL('scripts/popup.js', appRoot).href),
            import(new URL('scripts/templates.js', appRoot).href),
        ]);
    } catch {
        report('当前酒馆没有找到原生角色删除弹窗，请从酒馆角色管理中删除。');
        return;
    }
    if (typeof api.deleteCharacter !== 'function' || !popupModule.Popup?.show?.confirm) {
        report('当前酒馆没有找到原生角色删除接口，请从酒馆角色管理中删除。');
        return;
    }
    let deleteChats = false;
    const confirmed = await popupModule.Popup.show.confirm('删除角色？', await templateModule.renderTemplateAsync('deleteConfirm'), {
        onClose: () => { deleteChats = !!document.querySelector('#del_char_checkbox')?.checked; },
    });
    if (!confirmed) return;
    setBusy(true);
    try {
        const deleted = await api.deleteCharacter(entity.id, { deleteChats });
        if (!deleted) throw new Error('角色卡未删除，可能有正在保存的聊天。');
        invalidateArchiveData();
        for (const shell of shells) shell.draw();
        archive.close();
        globalThis.toastr?.success('已删除角色卡。', 'DW2 · Story Archive');
    } catch (error) {
        report(error.message || '角色卡删除失败，请刷新后重试。');
    } finally {
        setBusy(false);
    }
}

function editAlias(entity, row, refresh) {
    const { modal, body } = dialog('存档显示名');
    const input = element('input', 'jd-input'); input.type = 'text'; input.maxLength = 90;
    input.value = settings().aliases[aliasKey(entity.key, row.name)] || '';
    input.placeholder = displayChatName(entity, row, {}); input.setAttribute('aria-label', '存档显示名');
    const help = element('p', 'jd-dialog-intro', '给这一段故事取个容易认的名字。留空可恢复原名。');
    const commit = () => {
        const s = settings(); const key = aliasKey(entity.key, row.name);
        if (input.value.trim()) s.aliases[key] = input.value.trim(); else delete s.aliases[key];
        save(); refresh(); modal.close();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commit(); } });
    body.append(help, input, button('保存显示名', 'jd-primary-button', commit)); input.focus();
}

function editCrop(entity) {
    const { modal, body } = dialog('调整书架封面');
    const image = cover(entity, 'jd-cover jd-crop-preview');
    body.append(image, element('p', 'jd-dialog-intro', '这里只调整 DW2 书架封面，不会修改酒馆角色卡原图。'));
    const values = cropValues(entity);
    const source = imageSource(entity);
    const refreshPreview = () => {
        const art = image.querySelector('.jd-cover-art');
        if (art && source) applyCoverFrame(art, source, values);
    };
    for (const [key, title] of [['x', '左右位置'], ['y', '上下位置']]) {
        const label = element('label', 'jd-crop-label'); label.append(element('span', '', title));
        const range = element('input'); range.type = 'range'; range.min = '0'; range.max = '100'; range.value = String(values[key]);
        const updatePreview = () => { values[key] = Number(range.value); refreshPreview(); };
        range.addEventListener('input', updatePreview);
        range.addEventListener('change', updatePreview);
        label.append(range); body.append(label);
    }
    const zoomLabel = element('label', 'jd-crop-label');
    const zoomTitle = element('span', '', `缩放 ${values.zoom}%`);
    const zoom = element('input'); zoom.type = 'range'; zoom.min = '100'; zoom.max = '200'; zoom.step = '1'; zoom.value = String(values.zoom);
    const updateZoom = () => {
        values.zoom = zoomValue(zoom.value);
        zoomTitle.textContent = `缩放 ${values.zoom}%`;
        refreshPreview();
    };
    zoom.addEventListener('input', updateZoom);
    zoom.addEventListener('change', updateZoom);
    zoomLabel.append(zoomTitle, zoom); body.append(zoomLabel);
    body.append(element('p', 'jd-crop-hint', '想同时左右、上下移动时，先稍微放大一点。'));

    const coverActions = element('div', 'jd-cover-actions');
    if (entity.kind === 'char') {
        const replaceInput = element('input'); replaceInput.type = 'file'; replaceInput.accept = 'image/*'; replaceInput.hidden = true;
        const replace = button('设置书架封面', 'jd-text-button jd-set-shelf-cover', () => replaceInput.click(), '只替换 DW2 书架封面，不修改酒馆角色卡原图');
        replaceInput.addEventListener('change', () => {
            const file = replaceInput.files?.[0]; replaceInput.value = '';
            if (!file) return;
            safeAction(async () => {
                await setShelfCover(entity, file);
                modal.close();
                globalThis.toastr?.success('已设置独立书架封面。', 'DW2 · Story Archive');
            });
        });
        coverActions.append(replace, replaceInput);
        if (customCoverPath(entity)) {
            coverActions.append(button('恢复角色原图', 'jd-text-button jd-reset-shelf-cover', () => {
                safeAction(async () => {
                    await resetShelfCover(entity);
                    modal.close();
                    globalThis.toastr?.success('书架已恢复角色原图。', 'DW2 · Story Archive');
                });
            }, '移除 DW2 独立封面，重新显示酒馆角色卡原图'));
        }
    }
    if (coverActions.childElementCount) body.append(coverActions);
    body.append(button('保存封面位置', 'jd-primary-button', () => { settings().crops[entity.key] = values; save(); for (const shell of shells) shell.draw(); modal.close(); }));
}

function coverFileFormat(file) {
    const mime = String(file.type || '').toLowerCase();
    const byMime = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/bmp': 'bmp',
    };
    if (byMime[mime]) return byMime[mime];
    const ext = String(file.name || '').split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'jfif'].includes(ext) ? ext : '';
}
function coverFileBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败，请重新选择。'));
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            if (comma < 0) return reject(new Error('图片格式无法读取。'));
            resolve(result.slice(comma + 1));
        };
        reader.readAsDataURL(file);
    });
}
function coverKeyHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}
function ownedShelfCover(path) {
    return typeof path === 'string' && /(?:^|\/)user\/images\/DW2-Story-Archive\//.test(path);
}
async function deleteShelfCoverFile(path) {
    if (!ownedShelfCover(path)) return;
    const response = await fetch(url('api/images/delete'), {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ path }),
        cache: 'no-store',
    });
    if (!response.ok && response.status !== 404) console.warn('[DW2 Story Archive] 未能清理旧书架封面', response.status);
}
async function setShelfCover(entity, file) {
    if (entity.kind !== 'char') throw new Error('只有角色卡支持设置独立书架封面。');
    if (!file.type?.startsWith('image/')) throw new Error('请选择图片文件。');
    const format = coverFileFormat(file);
    if (!format) throw new Error('暂不支持这张图片格式，请使用 PNG、JPG、WEBP、GIF 或 BMP。');
    const image = await coverFileBase64(file);
    const filename = `dw2-${coverKeyHash(entity.key)}-${Date.now()}.${format}`;
    const response = await fetch(url('api/images/upload'), {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ image, format, filename, ch_name: 'DW2-Story-Archive' }),
        cache: 'no-store',
    });
    if (!response.ok) throw new Error('酒馆未能保存书架封面，请稍后重试。');
    const result = await response.json();
    if (!result?.path) throw new Error('酒馆没有返回书架封面路径。');

    const s = settings();
    const previous = s.covers[entity.key];
    s.covers[entity.key] = result.path;
    save();
    cardsRevision++;
    for (const shell of shells) shell.draw();
    if (previous && previous !== result.path) await deleteShelfCoverFile(previous);
}
async function resetShelfCover(entity) {
    const s = settings();
    const previous = s.covers[entity.key];
    if (!previous) return;
    delete s.covers[entity.key];
    save();
    cardsRevision++;
    for (const shell of shells) shell.draw();
    await deleteShelfCoverFile(previous);
}

function card(entity, shell) {
    const item = element('article', `jd-story-card${entity.assistant ? ' jd-assistant-card' : ''}`); item.dataset.key = entity.key;
    const main = button('', 'jd-open-card', () => { if (!shell.organizing) choose(entity); }, `打开${entity.name}`); main.disabled = opening;
    const image = cover(entity); const count = element('span', 'jd-save-count');
    count.textContent = entity.kind === 'assistant' ? '随时开始' : Number.isFinite(counts.get(entity.key)) ? `${counts.get(entity.key)} 个存档` : '查看存档';
    image.append(count);
    const text = element('div', 'jd-card-body');
    const name = element('h3', '', entity.name); name.title = entity.name;
    const tags = element('p', 'jd-card-tags', entity.assistant ? '随手聊聊 · 工具' : entity.tags.slice(0, 2).join(' / ') || (entity.kind === 'group' ? '群像故事' : '角色故事'));
    const bottom = element('div', 'jd-card-bottom');
    bottom.append(element('small', 'jd-last-played', entity.assistant ? '酒馆助手' : dateLabel(entity.last)), element('span', 'jd-card-action', '打开 ↗'));
    text.append(name, tags, bottom); main.append(image, text); item.append(main);
    const actions = element('div', 'jd-card-tools');
    if (!entity.assistant) {
        const pinned = isPinned(entity, settings());
        const pin = button('', 'jd-icon-button jd-pin', () => {
            const s = settings();
            const wasPinned = isPinned(entity, s);
            s.pinned = s.pinned.filter(key => key !== entity.key);
            if (!wasPinned) s.pinned.push(entity.key);
            save();
            for (const view of shells) view.draw();
            flashShelfNotice(shell, `${entity.name}${wasPinned ? '已取消置顶' : '已置顶'}`);
            [...shell.grid.children].find(card => card.dataset.key === entity.key)?.querySelector('.jd-pin')?.focus({ preventScroll: true });
        }, `${pinned ? '取消置顶' : '置顶'}${entity.name}`);
        pin.setAttribute('aria-pressed', String(pinned));
        actions.append(pin);
    }
    const favorite = button(isFavorite(entity, settings()) ? '★' : '☆', 'jd-icon-button jd-favorite', () => {
        settings().favorites[entity.key] = !isFavorite(entity, settings()); save(); for (const view of shells) view.draw();
    }, `收藏${entity.name}`);
    favorite.setAttribute('aria-pressed', String(isFavorite(entity, settings()))); actions.append(favorite);
    if (entity.kind === 'char' || imageSource(entity)) actions.append(button('⌖', 'jd-icon-button', () => editCrop(entity), `调整或更换${entity.name}的封面`));
    item.append(actions);
    shell.visible.set(entity.key, item);
    shell.organizer.decorateCard(item, main, entity);
    if (entity.kind !== 'assistant') {
        if (shell.visibility) shell.visibility.observe(item);
        else loadCount(entity).then(value => updateCounts(entity.key, value));
    }
    return item;
}

function createShelf(isHome = false) {
    const root = element('section', 'jd-bookshelf'); root.setAttribute('aria-label', '角色书架');
    const toolbar = element('div', 'jd-shelf-toolbar');
    const navigation = element('div', 'jd-shelf-navigation');
    const tabs = element('div', 'jd-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '筛选角色');
    const search = element('input', 'jd-input jd-search'); search.type = 'search'; search.placeholder = '搜索角色名或标签…'; search.setAttribute('aria-label', '搜索角色名或标签');
    const sortControl = element('div', 'jd-sort-control');
    const sortMenu = element('div', 'jd-sort-menu'); sortMenu.id = `jd-bookshelf-sort-${++dialogId}`;
    sortMenu.setAttribute('role', 'menu'); sortMenu.setAttribute('aria-label', '角色排序'); sortMenu.hidden = true;
    const sortItems = new Map();
    const closeSort = (restoreFocus = false) => {
        sortMenu.hidden = true; sort.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', outsideSort, true);
        if (restoreFocus && sort.isConnected) sort.focus({ preventScroll: true });
    };
    const outsideSort = event => { if (!sortControl.contains(event.target)) closeSort(); };
    const openSort = () => {
        sortMenu.hidden = false; sort.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', outsideSort, true);
        sortItems.get(normalizeSort(settings().sort))?.focus({ preventScroll: true });
    };
    const sort = button('排序', 'jd-tab jd-sort-toggle', () => sortMenu.hidden ? openSort() : closeSort(true));
    sort.setAttribute('aria-haspopup', 'menu'); sort.setAttribute('aria-expanded', 'false'); sort.setAttribute('aria-controls', sortMenu.id);
    for (const [value, label] of SORT_OPTIONS) {
        const option = button('', 'jd-sort-option', () => {
            closeSort(true);
            const s = settings();
            if (normalizeSort(s.sort) === value) return;
            if (value === 'custom' && !s.customOrder.length) {
                s.customOrder = filterEntities([...shell.entities.values()], '', 'all', s, counts)
                    .filter(entity => !entity.assistant)
                    .map(entity => entity.key);
            }
            s.sort = value; save();
            for (const view of shells) { view.page = 0; view.draw(); }
            shell.remember();
        });
        const mark = element('span', 'jd-sort-mark', '✓'); mark.setAttribute('aria-hidden', 'true');
        option.append(element('span', '', label), mark); option.dataset.sort = value;
        option.setAttribute('role', 'menuitemradio'); option.tabIndex = -1;
        sortItems.set(value, option); sortMenu.append(option);
    }
    sortControl.addEventListener('keydown', event => {
        if (event.target === sort && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); openSort(); return;
        }
        if (sortMenu.hidden) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSort(true); return; }
        if (event.key === 'Tab') { closeSort(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const options = [...sortItems.values()], current = options.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next].focus({ preventScroll: true });
    });
    sortControl.addEventListener('focusout', event => {
        if (event.relatedTarget && !sortControl.contains(event.relatedTarget)) closeSort();
    });
    sortControl.append(sort, sortMenu);
    navigation.append(tabs, sortControl);
    toolbar.append(navigation);
    if (isHome) toolbar.append(button('原版首页', 'jd-tab jd-native-home', () => { dismissedHome = true; reconcileHome(); }));
    toolbar.append(search);
    const info = element('div', 'jd-shelf-info'); const tally = element('span', 'jd-card-tally');
    const refresh = button('刷新 ↻', 'jd-text-button', () => { invalidateArchiveData(); for (const view of shells) view.draw(); });
    const sortStatus = element('span', 'jd-sort-status'); sortStatus.setAttribute('role', 'status');
    const addCharacter = button('', 'jd-add-character', openNativeCharacterImporter, '从文件导入角色卡');
    const addIcon = element('i', 'fa-solid fa-file-import'); addIcon.setAttribute('aria-hidden', 'true'); addCharacter.append(addIcon);
    const exportCharacter = button('', 'jd-add-character jd-export-character', openNativeCharacterExporter, '从书架导出角色卡');
    const exportIcon = element('i', 'fa-solid fa-file-export'); exportIcon.setAttribute('aria-hidden', 'true'); exportCharacter.append(exportIcon);
    const transfer = element('div', 'jd-card-transfer'); transfer.append(addCharacter, exportCharacter);
    const notice = element('p', 'jd-shelf-notice'); notice.setAttribute('role', 'status');
    const grid = element('div', 'jd-story-grid');
    const pager = element('nav', 'jd-pager'); pager.setAttribute('aria-label', '书架分页');
    const shell = { root, grid, notice, ...shelfView(settings()), query: '', sortRun: 0, noticeTimer: null,
        entities: new Map(), visible: new Map(), countTargets: new Set(), visibility: null, dispose: null, draw: null };
    shell.remember = () => {
        shell.viewTouched = true;
        if (rememberShelfView(settings(), { scope: shell.scope, filter: shell.filter, page: shell.query ? 0 : shell.page })) save();
    };
    shell.organizer = attachOrganizer({ shell, settings, save, element, button, dialog,
        redraw: () => { for (const view of shells) view.draw(); } });
    tabs.append(shell.organizer.control);
    const favoriteTab = button('收藏', 'jd-tab', () => { shell.filter = shell.filter === 'favorites' ? 'all' : 'favorites'; shell.page = 0; shell.draw(); shell.remember(); });
    favoriteTab.dataset.filter = 'favorites'; tabs.append(favoriteTab);
    info.append(tally, transfer, sortStatus, shell.organizer.organize, refresh);
    const pageLabel = element('span', 'jd-page-label'); pageLabel.setAttribute('aria-live', 'polite');
    const turnPage = delta => {
        shell.page += delta; shell.draw(); if (!shell.query) shell.remember();
        if (isHome) document.getElementById('chat').scrollTop = 0;
        else root.scrollIntoView({ block: 'start', behavior: 'instant' });
    };
    const previous = button('上一页', 'jd-text-button', () => turnPage(-1));
    const next = button('下一页', 'jd-text-button', () => turnPage(1));
    const sizeLabel = element('label', 'jd-page-size-label');
    const size = element('select', 'jd-page-size'); size.setAttribute('aria-label', '每页卡片数量');
    for (const value of [20, 40]) { const option = element('option', '', `${value} 张 / 页`); option.value = String(value); size.append(option); }
    size.value = String(settings().pageSize);
    size.addEventListener('change', () => {
        settings().pageSize = pageSize(size.value); save();
        for (const view of shells) { view.page = 0; view.draw(); }
        shell.remember();
    });
    sizeLabel.append(size); pager.append(previous, pageLabel, next, sizeLabel);
    root.append(toolbar, info, shell.organizer.bar, notice, grid, pager);
    if ('IntersectionObserver' in window) shell.visibility = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
            shell.visibility.unobserve(entry.target);
            const key = entry.target.dataset.key;
            // Ignore queued observations from a page that has already been replaced.
            if (shell.visible.get(key) !== entry.target) continue;
            const entity = shell.entities.get(key);
            if (entity) loadCount(entity).then(value => updateCounts(key, value));
        }
    }, { rootMargin: '180px 0px' });
    shell.draw = () => {
        const all = entitiesFromContext(ctx(), assistantAvatar());
        shell.entities = new Map(all.map(entity => [entity.key, entity]));
        const activeSort = normalizeSort(settings().sort);
        shell.customSort = activeSort === 'custom';
        root.classList.toggle('jd-custom-sort', shell.customSort);
        shell.organizer.beforeDraw();
        const chosen = filterEntities(filterFolder(all, shell.scope, settings()), shell.query, shell.filter, settings(), counts);
        const renderPage = ordered => {
            shell.visibility?.disconnect();
            const window = pageWindow(ordered, shell.page, settings().pageSize); shell.page = window.page;
            shell.visible.clear(); grid.replaceChildren(...window.items.map(entity => card(entity, shell)));
            if (!chosen.length) grid.append(element('p', 'jd-empty', shell.filter === 'favorites' ? '这里还没有收藏的角色卡。' : shell.scope === 'all' ? '没有找到匹配的角色卡或群聊。' : '这个文件夹里还没有匹配的卡片。点「整理」可批量移入。'));
            for (const entity of window.items) if (counts.has(entity.key)) updateCounts(entity.key, counts.get(entity.key));
            pageLabel.textContent = `${window.page + 1} / ${window.pages}`;
            previous.disabled = window.page === 0; next.disabled = window.page + 1 >= window.pages;
            size.value = String(settings().pageSize); pager.hidden = !chosen.length;
            shell.organizer.sync();
        };
        const characterCount = chosen.filter(e => e.kind === 'char' && !e.assistant).length;
        const groupCount = chosen.filter(e => e.kind === 'group').length;
        tally.textContent = `${characterCount} 张角色卡${groupCount ? ` · ${groupCount} 个群聊` : ''}${shell.query ? ' · 搜索结果' : ''}`;
        favoriteTab.setAttribute('aria-pressed', String(shell.filter === 'favorites'));
        sort.title = `当前排序：${SORT_OPTIONS.find(([value]) => value === activeSort)[1]}`;
        for (const [value, option] of sortItems) option.setAttribute('aria-checked', String(value === activeSort));
        const run = ++shell.sortRun;
        shell.countTargets = new Set(activeSort === 'count' ? chosen.filter(e => !e.assistant).map(e => e.key) : []);
        renderPage(chosen);
        sortStatus.textContent = activeSort === 'custom' ? '长按拖动卡片调整顺序' : '';
        if (activeSort === 'count') {
            const targets = chosen.filter(entity => !entity.assistant);
            const missing = targets.filter(entity => !counts.has(entity.key));
            const showUnknown = () => {
                const unknown = targets.filter(entity => !Number.isFinite(counts.get(entity.key))).length;
                sortStatus.textContent = unknown ? `${unknown} 张卡数量未读到，可点刷新重试` : '';
            };
            if (missing.length) {
                sortStatus.textContent = '正在统计存档…';
                const revision = cardsRevision;
                Promise.all(missing.map(entity => loadCount(entity))).then(() => {
                    if (!enabledRuntime || !shells.has(shell) || run !== shell.sortRun || revision !== cardsRevision || normalizeSort(settings().sort) !== 'count') return;
                    renderPage(filterEntities(chosen, '', 'all', settings(), counts)); showUnknown();
                });
            } else showUnknown();
        }
    };
    let searchTimer;
    const scheduleSearch = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            shell.query = search.value;
            const saved = shelfView(settings());
            shell.page = !shell.query && saved.scope === shell.scope && saved.filter === shell.filter ? saved.page : 0;
            shell.draw();
        }, 100);
    };
    search.addEventListener('input', event => { if (!event.isComposing) scheduleSearch(); });
    search.addEventListener('compositionend', scheduleSearch);
    shell.dispose = () => { shell.layout?.dispose(); closeSort(); clearTimeout(searchTimer); clearTimeout(shell.noticeTimer); shell.noticeTimer = null; shell.sortRun++; shell.organizer.dispose(); shell.visibility?.disconnect(); shell.visible.clear(); shell.countTargets.clear(); shells.delete(shell); };
    shells.add(shell); shell.draw(); return shell;
}

function hasSelection() {
    const c = ctx();
    return (c.characterId !== undefined && c.characterId !== null && c.characterId !== '') || (c.groupId !== undefined && c.groupId !== null && c.groupId !== '');
}
function unmountHome() {
    document.body.classList.remove('jd-bookshelf-home-active');
    document.getElementById('chat')?.classList.remove('jd-bookshelf-home');
    if (rootHome) { rootHome.dispose(); rootHome.root.remove(); rootHome = null; }
}
function reconcileHome() {
    const chat = document.getElementById('chat');
    const welcome = chat?.querySelector('.welcomePanel');
    const eligible = enabledRuntime && settings().enabled && !hasSelection() && welcome;
    const returnButton = document.getElementById('jd-bookshelf-return');
    if (eligible && dismissedHome) {
        let entry = returnButton;
        if (!entry) {
            entry = button('', 'menu_button menu_button_icon', restoreHome, '返回书架');
            entry.id = 'jd-bookshelf-return';
            const icon = element('i', 'fa-solid fa-book-open');
            icon.setAttribute('aria-hidden', 'true');
            entry.append(icon, element('span', '', '书架'));
        }
        // Share the native welcome shortcuts row; keep its other controls intact.
        const shortcuts = welcome.querySelector('.welcomeShortcuts') || welcome.querySelector('.welcomeHeader') || welcome;
        if (entry.parentElement !== shortcuts) shortcuts.append(entry);
    } else returnButton?.remove();
    if (!eligible || dismissedHome) { unmountHome(); return; }
    if (rootHome?.root.isConnected) return;
    unmountHome(); rootHome = createShelf(true); chat.prepend(rootHome.root);
    chat.classList.add('jd-bookshelf-home'); document.body.classList.add('jd-bookshelf-home-active');
    rootHome.layout = attachHomeLayout(chat, rootHome.root);
    chat.scrollTop = 0;
}
function scheduleHome() { if (frame || !enabledRuntime) return; frame = requestAnimationFrame(() => { frame = null; reconcileHome(); }); }

function restoreHome() {
    dismissedHome = false;
    reconcileHome();
    if (rootHome?.root.isConnected) {
        document.getElementById('chat').scrollTop = 0;
        rootHome.root.querySelector('.jd-tab')?.focus({ preventScroll: true });
    }
}
function openNativeCharacterExporter() {
    if (opening) { report('书架正在处理其他操作，请稍候。'); return; }
    const cards = entitiesFromContext(ctx(), assistantAvatar())
        .filter(entity => entity.kind === 'char')
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
    if (!cards.length) { report('当前没有可以导出的角色卡。'); return; }

    const { modal, body, notice } = dialog('导出角色卡');
    modal.classList.add('jd-character-export-dialog');
    body.append(element('p', 'jd-dialog-intro', '选择角色卡后导出 PNG 或 JSON。导出使用 TT 原生角色数据，不包含聊天记录或书架独立封面。'));
    const search = element('input', 'jd-input jd-character-export-search');
    search.type = 'search'; search.placeholder = '搜索角色名或文件名…';
    search.setAttribute('aria-label', '搜索要导出的角色卡');
    const list = element('div', 'jd-character-export-list');
    const selectedLabel = element('p', 'jd-dialog-intro jd-character-export-selected', '请选择要导出的角色卡。');
    const actions = element('div', 'jd-character-export-actions');
    let selected = null, busy = false;

    async function exportCard(format) {
        if (busy || !selected || !modal.open) return;
        if (!ctx().characters?.some(character => character?.avatar === selected.id)) {
            notice.textContent = '这张角色卡已不存在，请关闭窗口重新选择。';
            return;
        }
        busy = true;
        png.disabled = json.disabled = search.disabled = true;
        notice.textContent = '正在准备角色卡文件…';
        try {
            const response = await fetch(url('api/characters/export'), {
                method: 'POST',
                headers: { ...ctx().getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ avatar_url: selected.id, format }),
                cache: 'no-store',
            });
            if (!response.ok) {
                let detail = '';
                try { const result = await response.json(); detail = result?.error || result?.message || ''; } catch {}
                throw new Error(detail || ('角色卡导出失败（HTTP ' + response.status + '）'));
            }
            const blob = await response.blob();
            if (!blob.size) throw new Error('酒馆返回了空文件，已停止导出。');
            const stem = String(selected.id).replace(/\.png$/i, '')
                .replace(/[\\/:*?"<>|]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100) || '角色卡';
            // Reuse the host's download pipeline: iPhone receives the native Share Sheet.
            const { downloadBlobWithRuntime } = await import(new URL('scripts/file-export.js', appRoot).href);
            const result = await downloadBlobWithRuntime(blob, stem + '.' + format, { fallbackName: '角色卡.' + format });
            notice.textContent = result?.completed === false
                ? '已取消系统分享，没有保存文件。'
                : result?.mode === 'ios-native-share'
                    ? '✓ 角色卡已通过系统分享菜单导出。'
                    : '✓ 文件已提交给系统下载或保存，请检查保存位置。';
        } catch (error) {
            console.warn('[DW2 Story Archive] 角色卡导出失败', error);
            notice.textContent = error?.message || '角色卡导出失败，请稍后重试。';
        } finally {
            busy = false;
            search.disabled = false;
            png.disabled = json.disabled = !selected;
        }
    }

    const png = button('导出 PNG', 'jd-primary-button jd-character-export-action', () => { void exportCard('png'); });
    const json = button('导出 JSON', 'jd-secondary-button jd-character-export-action', () => { void exportCard('json'); });
    png.disabled = json.disabled = true;
    actions.append(png, json);
    const draw = () => {
        list.replaceChildren();
        const query = search.value.trim().toLocaleLowerCase();
        const matches = cards.filter(card => !query || card.name.toLocaleLowerCase().includes(query) || card.id.toLocaleLowerCase().includes(query));
        if (!matches.length) list.append(element('p', 'jd-dialog-intro', '没有找到对应角色卡。'));
        for (const card of matches) {
            const chosen = button('', 'jd-character-export-row', () => {
                if (busy) return;
                selected = card;
                selectedLabel.textContent = '已选择：' + card.name + '（' + card.id + '）';
                notice.textContent = '';
                png.disabled = json.disabled = false;
                draw();
            }, '选择角色卡 ' + card.name + '（' + card.id + '）');
            chosen.setAttribute('aria-pressed', String(card.key === selected?.key));
            chosen.append(element('span', 'jd-character-export-name', card.name), element('small', 'jd-character-export-file', card.id));
            list.append(chosen);
        }
    };
    search.addEventListener('input', draw);
    body.append(search, list, selectedLabel, actions);
    draw(); search.focus({ preventScroll: true });
}

function openNativeCharacterImporter() {
    // Reuse the native import button in the user's click stack. This opens
    // the OS file picker without leaving the bookshelf or navigating through
    // the character-management home screen.
    const native = document.getElementById('character_import_button');
    const input = document.getElementById('character_import_file');
    if (native) native.click();
    else if (input) input.click();
    else report('当前酒馆没有找到原生角色卡导入入口。');
}
function openShelf() {
    if (opening) { report('正在打开存档，请稍候。'); return; }
    if (!hasSelection() && settings().enabled && document.querySelector('#chat .welcomePanel')) { restoreHome(); return; }
    if (rootHome?.root.isConnected) { document.getElementById('chat').scrollTop = 0; rootHome.root.querySelector('.jd-search').focus(); return; }
    const { modal, body } = dialog('DW2 · Story Archive', true);
    const shelf = createShelf(); body.append(shelf.root);
    modal.addEventListener('close', shelf.dispose, { once: true });
}
function installControls() {
    if (!document.getElementById('jd-bookshelf-open')) {
        const menu = document.getElementById('extensionsMenu');
        if (menu) {
            const entry = element('div', 'list-group-item flex-container flexGap5 interactable'); entry.id = 'jd-bookshelf-open'; entry.tabIndex = 0; entry.setAttribute('role', 'button'); entry.setAttribute('aria-disabled', String(opening));
            entry.append(element('i', 'fa-solid fa-book-open'), element('span', '', 'Story Archive'));
            entry.addEventListener('click', openShelf); entry.addEventListener('keydown', e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); openShelf(); } }); menu.append(entry);
        }
    }
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (host && !document.getElementById('jd-bookshelf-settings')) {
        const panel = element('div'); panel.id = 'jd-bookshelf-settings';
        const drawer = element('div', 'inline-drawer');
        const header = element('div', 'inline-drawer-toggle inline-drawer-header');
        const icon = element('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
        icon.setAttribute('aria-hidden', 'true');
        header.tabIndex = 0; header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', 'false'); header.setAttribute('aria-controls', 'jd-bookshelf-settings-content');
        header.append(element('b', '', 'DW2 · Story Archive'), icon);
        // Native delegated click handling owns the drawer and its theme styling.
        header.addEventListener('click', () => header.setAttribute('aria-expanded', String(icon.classList.contains('down'))));
        header.addEventListener('keydown', event => {
            if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); header.click(); }
        });
        const content = element('div', 'inline-drawer-content'); content.id = 'jd-bookshelf-settings-content';
        content.append(element('small', 'jd-install-status', `已加载 · V${BOOKSHELF_VERSION} · DW2 独立视觉`));
        const label = element('label', 'checkbox_label'); const check = element('input'); check.type = 'checkbox'; check.checked = settings().enabled;
        check.addEventListener('change', () => { settings().enabled = check.checked; dismissedHome = false; save(); scheduleHome(); });
        label.append(check, element('span', '', '首页显示 Story Archive'));
        content.append(label, button('打开书架', 'menu_button', openShelf), element('small', '', '封面右上角：图钉置顶、星号收藏、裁切调整封面。置顶按点击先后排列，其余可切换排序；点封面进入存档列表，右上角可新建聊天。'));
        content.append(button('版本与更新', 'menu_button jd-version-open', showVersionManager));
        drawer.append(header, content); panel.append(drawer); host.append(panel);
    }
}
export function onEnable() {
    if (enabledRuntime) return;
    enabledRuntime = true;
    const context = ctx(); const types = context.eventTypes || context.event_types;
    const subscribe = (type, fn) => { if (type) { context.eventSource.on(type, fn); listeners.push([type, fn]); } };
    const ready = () => { installControls(); if (!observer && document.getElementById('chat')) { observer = new MutationObserver(scheduleHome); observer.observe(document.getElementById('chat'), { childList: true }); } scheduleHome(); };
    subscribe(types.APP_READY, () => {
        ready();
        for (const shell of shells) if (!shell.viewTouched) { Object.assign(shell, shelfView(settings())); shell.draw(); }
    });
    subscribe(types.CHAT_CHANGED, () => { dismissedHome = false; invalidateArchiveData(); document.querySelectorAll('.jd-shelf-dialog[open]').forEach(d => d.close()); scheduleHome(); });
    for (const type of [types.CHARACTER_EDITED, types.CHARACTER_DELETED, types.CHARACTER_DUPLICATED, types.CHARACTERS_IMPORTED, types.CHAT_DELETED, types.GROUP_CHAT_DELETED, types.CHAT_RENAMED, types.CHAT_CREATED]) subscribe(type, () => {
        invalidateArchiveData(); for (const shell of shells) shell.draw(); scheduleHome();
    });
    // Also supports enabling after APP_READY has already fired.
    ready();
}
export function onDisable() {
    enabledRuntime = false;
    versionManager?.dispose(); versionManager = null;
    for (const request of requests) request.abort(); requests.clear();
    invalidateArchiveData();
    const source = ctx().eventSource;
    for (const [type, fn] of listeners.splice(0)) source.removeListener ? source.removeListener(type, fn) : source.off(type, fn);
    observer?.disconnect(); observer = null;
    if (frame) cancelAnimationFrame(frame); frame = null;
    unmountHome(); document.querySelectorAll('.jd-shelf-dialog[open]').forEach(d => d.close());
    document.getElementById('jd-bookshelf-open')?.remove(); document.getElementById('jd-bookshelf-settings')?.remove();
    document.getElementById('jd-bookshelf-return')?.remove();
}
onEnable();
