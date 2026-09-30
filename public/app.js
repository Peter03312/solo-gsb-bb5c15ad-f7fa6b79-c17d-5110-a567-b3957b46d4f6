'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { materials: [], packages: [], basisVersion: 0, authEdit: null };

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 ${res.status}`);
    err.status = res.status;
    err.details = data && data.details;
    err.data = data;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

function errText(e) {
  return e.message + (e.details && e.details.code === 'STALE_BASIS' ? '' : '');
}

// ---------------- 数据加载 ----------------
async function loadState() {
  const [s, mats, pkgs] = await Promise.all([
    api('GET', '/api/state'),
    api('GET', '/api/materials'),
    api('GET', '/api/packages'),
  ]);
  state.materials = mats;
  state.packages = pkgs;
  state.basisVersion = s.basisVersion;
  $('#basisVersion').textContent = s.basisVersion;
  const rb = $('#reviewBadge');
  if (s.reviewCount > 0) { rb.textContent = `需复核：${s.reviewCount}`; rb.classList.remove('hidden'); }
  else rb.classList.add('hidden');
  renderMaterials();
  renderMaterialPick();
  renderPackages();
}

// ---------------- Tabs ----------------
$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tabpanel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
  $$('.tabpanel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${btn.dataset.tab}`));
}));

// ---------------- 素材页 ----------------
function renderMaterials() {
  const box = $('#materialsList');
  if (!state.materials.length) {
    box.innerHTML = '<div class="small-muted">还没有素材，先在上方登记一个。</div>';
    return;
  }
  box.innerHTML = state.materials.map((m) => `
    <div class="card" data-id="${m.id}">
      <h3>${esc(m.title)} <span class="small-muted">#${m.id}</span></h3>
      <div class="meta">${esc(m.kind || '未分类')}${m.note ? ' · ' + esc(m.note) : ''}</div>

      <div class="section-title">来源（本素材使用了下列素材，逐层向上核验）</div>
      <div>${m.sources.map((s) => `
        <span class="chip">← ${esc(s.sourceTitle)}
          <span class="small-muted">(${esc(s.relation)})</span>
          <button title="预演删除该来源关系的影响" data-act="preview-del-link" data-id="${s.id}">×</button>
        </span>`).join('') || '<span class="small-muted">无</span>'}
      </div>
      <form class="mini" data-act="add-link">
        <input type="hidden" name="materialId" value="${m.id}" />
        <select name="sourceMaterialId" required>
          <option value="">选择来源素材…</option>
          ${state.materials.filter((x) => x.id !== m.id && !m.sources.some((s) => s.sourceMaterialId === x.id))
            .map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join('')}
        </select>
        <input name="relation" placeholder="关系（如 配乐）" style="width:110px" />
        <button class="btn btn-small" type="submit">＋ 来源</button>
        <button class="btn btn-small" type="button" data-act="preview-link-add"
          title="先预演此变更对已发布包的影响，不写入任何数据">预演影响</button>
      </form>

      <div class="section-title">授权</div>
      ${m.authorizations.length ? `
        <table class="auth">
          <tr><th>媒介</th><th>地区</th><th>有效期</th><th>状态</th><th>授权方</th><th></th></tr>
          ${m.authorizations.map((a) => `
            <tr class="${a.revoked ? 'revoked' : ''}">
              <td>${esc(a.media)}</td><td>${esc(a.region)}</td>
              <td>${a.validFrom} → ${a.validTo}</td>
              <td>${a.revoked ? '<span class="pill pill-bad">已撤销</span>' : '<span class="pill pill-ok">有效</span>'}</td>
              <td>${esc(a.licensor || '')}</td>
              <td class="pkg-actions">
                <button class="btn btn-small" data-act="preview-edit-auth" data-id="${a.id}">修改/预演</button>
                ${a.revoked ? '' : `<button class="btn btn-small" data-act="preview-revoke" data-id="${a.id}">撤销/预演</button>`}
                <button class="btn btn-small btn-danger" data-act="preview-del-auth" data-id="${a.id}">删除/预演</button>
              </td>
            </tr>`).join('')}
        </table>` : '<span class="small-muted">无授权登记</span>'}
      <form class="mini" data-act="add-auth" data-material="${m.id}">
        <input type="hidden" name="materialId" value="${m.id}" />
        <input type="hidden" name="authorizationId" value="" />
        <span class="auth-form-label">＋ 授权</span>
        <input name="media" placeholder="媒介（* 任意）" style="width:100px" required />
        <input name="region" placeholder="地区（* 任意）" style="width:100px" required />
        <input name="validFrom" type="date" required />
        <input name="validTo" type="date" required />
        <label class="rev-check"><input type="checkbox" name="revoked" /> 已撤销</label>
        <input name="licensor" placeholder="授权方" style="width:100px" />
        <input name="note" placeholder="备注" style="width:110px" />
        <button class="btn btn-small" type="submit" data-act-submit="save">保存</button>
        <button class="btn btn-small" type="button" data-act="preview-save-auth"
          title="先预演此授权（新增或修改）对已发布包的影响，不写入任何数据">预演影响</button>
        <button class="btn btn-small hidden" type="button" data-act="cancel-edit-auth">取消修改</button>
      </form>

      <div class="section-title">被用于</div>
      <div>${m.usedBy.map((u) => `<span class="chip">${esc(u.materialTitle)} <span class="small-muted">(${esc(u.relation)})</span></span>`).join('') || '<span class="small-muted">无</span>'}</div>
    </div>`).join('');

  // 重新渲染后若处于“修改授权”模式，把对应表单重新置为编辑态
  if (state.authEdit) {
    for (const mm of state.materials) {
      const a = mm.authorizations.find((x) => x.id === state.authEdit);
      if (a) {
        const card = document.querySelector(`.card[data-id="${mm.id}"]`);
        if (card) fillAuthForm(card, a);
        break;
      }
    }
  }
}

$('#addMaterialForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/materials', { title: f.title.value, kind: f.kind.value });
    f.reset();
    await loadState();
    toast('素材已登记');
  } catch (err) { toast(errText(err), true); }
});

// ---------------- 变更影响预演面板 ----------------
let impactState = null; // 当前预演结果：{ result, op, body }

function authBodyFromForm(form) {
  const body = {
    media: form.media.value, region: form.region.value,
    validFrom: form.validFrom.value, validTo: form.validTo.value,
    revoked: form.revoked.checked,
    licensor: form.licensor.value, note: form.note.value,
  };
  const authId = form.authorizationId.value;
  return { body, authId: authId ? Number(authId) : null, materialId: Number(form.materialId.value) };
}

async function requestImpact(op, body) {
  try {
    const result = await api('POST', '/api/preview/impact', { op, ...body });
    impactState = { result, op, body };
    renderImpact(result, op);
    $('#impactPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    impactState = null;
    hideImpact();
    if (err.status === 409 && err.details && err.details.cyclePath) {
      const cycle = err.details.cycle || err.details.cyclePath;
      const names = cycle.map((id) => {
        const mm = state.materials.find((x) => x.id === id);
        return mm ? mm.title : `#${id}`;
      });
      toast(`${err.message} 闭环路径：${names.join(' → ')}`, true);
    } else toast(errText(err), true);
  }
}

function hideImpact() { $('#impactPanel').classList.add('hidden'); $('#impactPanel').innerHTML = ''; }

function renderImpact(result, op) {
  const panel = $('#impactPanel');
  panel.classList.remove('hidden');
  const staleHint = `
    <div class="impact-stale">
      ⏳ 此预演基于<b>依据版本 ${result.basisVersion}</b>。预演不会改动任何数据；若确认前他人修改了授权或来源关系，
      确认将因依据过期（409 STALE_BASIS）被拒绝，需重新预演。
    </div>`;
  const list = result.affectedCount === 0
    ? '<div class="impact-empty">✓ 该变更不会使任何已发布展览包由合格转为不合格。</div>'
    : result.affectedPackages.map((p) => `
      <div class="impact-pkg">
        <div class="impact-pkg-head">
          <b>${esc(p.name)}</b> <span class="small-muted">#${p.packageId}</span>
          <span class="pill pill-warn">已发布 → 需复核</span>
        </div>
        ${p.failingNodes.map((n) => `
          <div class="impact-node">
            <span class="fail-node">${esc(n.title)}</span>
            <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span>
            ${n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}
            <div class="small-muted">问题来源路径（${n.paths.length} 条）：</div>
            ${n.paths.map((pp) => '<div class="path">' + pp.map((x, i) =>
              (i ? ' → ' : '') + `<span class="${x.materialId === n.materialId ? 'fail-node' : ''}">${esc(x.title)}</span>`).join('') + '</div>').join('')}
          </div>`).join('')}
      </div>`).join('');
  panel.innerHTML = `
    <div class="impact-head">
      <h2>变更影响预演 <span class="pill pill-neutral">只读 · 不写入</span></h2>
      <div class="small-muted">${esc(result.opText)}：${esc(result.operation)}</div>
    </div>
    <div class="verdict ${result.affectedCount === 0 ? 'pass' : 'fail'}">
      ${esc(result.message)}
      <span class="sub">预演依据版本 ${result.basisVersion}（提交时服务端会再次比对当前版本）</span>
    </div>
    ${staleHint}
    <div class="impact-list">${list}</div>
    <div class="pkg-actions" style="margin-top:10px">
      <button class="btn btn-primary" id="impactConfirmBtn">确认提交此变更</button>
      <button class="btn" id="impactCancelBtn">取消</button>
      <span class="small-muted">确认时服务端会在事务内再次校验依据版本并重算影响；版本或影响清单不一致将整体拒绝，不产生部分写入。成功后${
        result.affectedCount === 0 ? '仅执行变更。' : '受影响包将标记需复核并追加不可变快照（原发布快照保留，需复核包不自动恢复）。'}</span>
    </div>`;
  $('#impactCancelBtn').addEventListener('click', hideImpact);
  $('#impactConfirmBtn').addEventListener('click', () => doImpactConfirm(op));
}

async function doImpactConfirm(op) {
  if (!impactState) return;
  const { result, body } = impactState;
  const btn = $('#impactConfirmBtn');
  btn.disabled = true;
  try {
    const payload = { ...body, basisVersion: result.basisVersion, impactFingerprint: result.impactFingerprint };
    const r = await api('POST', '/api/preview/confirm', payload);
    hideImpact();
    impactState = null;
    toast(r.affectedCount === 0
      ? `变更已提交（依据版本 ${r.basisVersion} → ${r.newBasisVersion}），无已发布包受影响`
      : `变更已提交：${r.affectedCount} 个已发布包标记需复核，不可变复核快照已追加`);
    state.authEdit = null;
    await loadState();
  } catch (err) {
    if (err.status === 409 && err.details && (err.details.code === 'STALE_BASIS' || err.details.code === 'IMPACT_MISMATCH')) {
      // 依据过期/清单不一致：已被服务端拒绝且无写入；展示按当前数据重算的最新影响，要求重新预演
      const fresh = err.details.impact;
      toast('预演已过期或影响清单已变化：已拒绝提交，无任何写入。请核对后重新预演。', true);
      if (fresh) {
        impactState = {
          result: {
            ...fresh,
            dryRun: true, opText: impactState.result.opText, operation: impactState.result.operation,
            message: '以下为按当前数据重算的最新影响（仅展示）。若仍要提交，请重新发起一次预演再确认。',
          },
          op,
          body: impactState.body,
        };
        renderImpact(impactState.result, op);
        $('#impactPanel').insertAdjacentHTML('afterbegin',
          '<div class="errorline">⚠ ' + esc(err.message) + '</div>');
        const cbtn = $('#impactConfirmBtn');
        if (cbtn) {
          cbtn.disabled = true;
          cbtn.textContent = '依据已过期，请重新预演';
        }
      }
    } else toast(errText(err), true);
  } finally {
    const b = $('#impactConfirmBtn');
    if (b) b.disabled = false;
  }
}

// 授权表单：新增 / 修改两种模式
function fillAuthForm(card, a) {
  const form = card.querySelector('form[data-act="add-auth"]');
  const label = form.querySelector('.auth-form-label');
  if (a) {
    state.authEdit = a.id;
    form.authorizationId.value = a.id;
    form.media.value = a.media;
    form.region.value = a.region;
    form.validFrom.value = a.validFrom;
    form.validTo.value = a.validTo;
    form.revoked.checked = !!a.revoked;
    form.licensor.value = a.licensor || '';
    form.note.value = a.note || '';
    label.textContent = `修改授权 #${a.id}`;
    form.querySelector('[data-act-submit]').textContent = '保存修改';
    form.querySelector('[data-act="cancel-edit-auth"]').classList.remove('hidden');
  } else {
    state.authEdit = null;
    form.reset();
    form.authorizationId.value = '';
    label.textContent = '＋ 授权';
    form.querySelector('[data-act-submit]').textContent = '保存';
    form.querySelector('[data-act="cancel-edit-auth"]').classList.add('hidden');
  }
}

$('#materialsList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = e.target.closest('.card');
  const act = btn.dataset.act;
  try {
    if (act === 'preview-revoke') {
      await requestImpact('authz_revoke', { authorizationId: Number(btn.dataset.id) });
    } else if (act === 'preview-del-auth') {
      await requestImpact('authz_delete', { authorizationId: Number(btn.dataset.id) });
    } else if (act === 'preview-edit-auth') {
      const a = state.materials.flatMap((m) => m.authorizations).find((x) => x.id === Number(btn.dataset.id));
      if (!card) return;
      fillAuthForm(card, a);
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      toast('已载入授权到下方表单，修改后点「预演影响」');
    } else if (act === 'cancel-edit-auth') {
      fillAuthForm(card, null);
    } else if (act === 'preview-del-link') {
      await requestImpact('link_delete', { linkId: Number(btn.dataset.id) });
    } else if (act === 'preview-link-add') {
      const form = card.querySelector('form[data-act="add-link"]');
      if (!form.sourceMaterialId.value) { toast('请先选择来源素材', true); return; }
      await requestImpact('link_create', {
        materialId: Number(form.materialId.value),
        sourceMaterialId: Number(form.sourceMaterialId.value),
        relation: form.relation.value,
      });
    } else if (act === 'preview-save-auth') {
      const form = card.querySelector('form[data-act="add-auth"]');
      form.reportValidity();
      if (!form.checkValidity()) return;
      const { body, authId, materialId } = authBodyFromForm(form);
      await requestImpact(authId ? 'authz_update' : 'authz_create',
        authId ? { ...body, authorizationId: authId } : { ...body, materialId });
    }
  } catch (err) { toast(errText(err), true); }
});

$('#materialsList').addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-act]');
  if (!form) return;
  e.preventDefault();
  try {
    if (form.dataset.act === 'add-link') {
      await api('POST', `/api/materials/${form.materialId.value}/sources`, {
        sourceMaterialId: Number(form.sourceMaterialId.value),
        relation: form.relation.value,
      });
      toast('来源关系已登记，已重新计算已发布包资格');
    } else if (form.dataset.act === 'add-auth') {
      const { body, authId, materialId } = authBodyFromForm(form);
      if (authId) {
        await api('PATCH', `/api/authorizations/${authId}`, body);
        toast('授权已修改，已重新计算已发布包资格');
      } else {
        await api('POST', `/api/materials/${materialId}/authorizations`, body);
        toast('授权已登记');
      }
      state.authEdit = null;
    }
    await loadState();
  } catch (err) {
    if (err.status === 409 && err.details && err.details.cyclePath) {
      const cycle = err.details.cycle || err.details.cyclePath;
      const names = cycle.map((id) => {
        const m = state.materials.find((x) => x.id === id);
        return m ? m.title : `#${id}`;
      });
      toast(`${err.message} 闭环路径：${names.join(' → ')}`, true);
    } else toast(errText(err), true);
  }
});

// ---------------- 展览包页 ----------------
function renderMaterialPick() {
  const pick = $('#materialPick');
  const selected = new Set($$('#materialPick input:checked').map((i) => i.value));
  if (!state.materials.length) { pick.innerHTML = '<span class="small-muted">请先到「素材与来源」页登记素材</span>'; return; }
  pick.innerHTML = state.materials.map((m) => `
    <label><input type="checkbox" name="materialIds" value="${m.id}" ${selected.has(String(m.id)) ? 'checked' : ''} />
      ${esc(m.title)} <span class="small-muted">#${m.id}</span></label>`).join('');
}

function readPkgForm() {
  const f = $('#packageForm');
  return {
    packageId: f.packageId.value ? Number(f.packageId.value) : null,
    name: f.name.value.trim(),
    medium: f.medium.value.trim(),
    region: f.region.value.trim(),
    useFrom: f.useFrom.value,
    useTo: f.useTo.value,
    materialIds: $$('#materialPick input:checked').map((i) => Number(i.value)),
  };
}

function fillPkgForm(pkg) {
  const f = $('#packageForm');
  f.packageId.value = pkg.id || '';
  f.name.value = pkg.name || '';
  f.medium.value = pkg.medium || '';
  f.region.value = pkg.region || '';
  f.useFrom.value = pkg.useFrom || '';
  f.useTo.value = pkg.useTo || '';
  renderMaterialPick();
  const ids = new Set((pkg.items || pkg.materialIds || []).map((x) => typeof x === 'object' ? x.id : x));
  $$('#materialPick input').forEach((i) => { i.checked = ids.has(Number(i.value)); });
  $('#pkgFormTitle').textContent = pkg.id ? `编辑待发布包 #${pkg.id}` : '新建待发布展览包';
  $('#savePkgBtn').textContent = pkg.id ? '保存修改' : '保存待发布包';
  $('#verifyPanel').classList.add('hidden');
}

$('#newPkgBtn').addEventListener('click', () => fillPkgForm({}));

$('#packageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = readPkgForm();
  try {
    let pkg;
    if (b.packageId) {
      pkg = await api('PATCH', `/api/packages/${b.packageId}`, b);
      toast('待发布包已更新');
    } else {
      pkg = await api('POST', '/api/packages', b);
      toast('待发布包已保存');
    }
    await loadState();
    fillPkgForm(pkg);
  } catch (err) { toast(errText(err), true); }
});

// ---- 核验 ----
$('#verifyPkgBtn').addEventListener('click', async () => {
  const b = readPkgForm();
  try {
    const body = b.packageId
      ? { packageId: b.packageId }
      : { materialIds: b.materialIds, medium: b.medium, region: b.region, useFrom: b.useFrom, useTo: b.useTo };
    const result = await api('POST', '/api/verify', body);
    renderVerify(result, b);
  } catch (err) { toast(errText(err), true); }
});

function pathHtml(pathArr) {
  return '<div class="path">' + pathArr.map((n, i) =>
    (i ? ' → ' : '') + `<span>${esc(n.title)}</span>`).join('') + '</div>';
}

function renderVerify(result, formData, mode = 'publish') {
  // mode: 'publish'（待发布包，可发布）| 'recheck'（已发布/需复核包，只能人工复核）
  const panel = $('#verifyPanel');
  panel.classList.remove('hidden');
  const globalErrs = (result.globalErrors || []).map((m) => `<div class="errorline">${esc(m)}</div>`).join('');
  const itemErrs = (result.itemErrors || []).map((x) => `<div class="errorline">${esc(x.message)}</div>`).join('');
  const fail = (result.failingNodes || []).map((n) => `
    <div class="card" style="margin-bottom:8px">
      <h3><span class="fail-node">${esc(n.title)}</span> <span class="small-muted">#${n.materialId}${n.isRoot ? '（入展品）' : ''}</span></h3>
      <div>${n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</div>
      <div class="section-title">不合格来源路径（共 ${n.paths.length} 条${result.stats.pathCountTruncated ? '，过多已截断' : ''}）</div>
      ${n.paths.map((p) => '<div class="path">' + p.map((x, i) =>
        (i ? ' → ' : '') + `<span class="${x.materialId === n.materialId ? 'fail-node' : ''}">${esc(x.title)}</span>`).join('') + '</div>').join('')}
    </div>`).join('');

  const verdictText = mode === 'recheck'
    ? (result.eligible ? '✓ 复核通过：当前全部来源链节点均合格，可恢复为已发布。'
                      : '✗ 复核不通过：仍存在不合格节点，包保持需复核状态。')
    : (result.eligible ? '✓ 核验通过：来源链上每个节点都有未撤销且覆盖整段使用的授权，可以发布。'
                      : '✗ 核验不通过：存在不合格节点或输入错误，禁止发布。');

  const actionArea = mode === 'publish' && result.eligible && formData.packageId ? `
      <div class="pkg-actions">
        <button class="btn btn-primary" id="publishBtn">按此次核验结果原子发布</button>
        <span class="small-muted">发布将再次按当前数据重算并校验依据版本；若期间授权被修改会被拒绝。</span>
      </div>`
    : (mode === 'publish' && result.eligible ? '<div class="small-muted">请先「保存待发布包」，再执行发布。</div>' : '');

  panel.innerHTML = `
    <div class="verdict ${result.eligible ? 'pass' : 'fail'}">
      ${verdictText}
      <span class="sub">入展品 ${result.stats.rootCount} 个 · 来源链节点 ${result.stats.nodeCount} 个 · 不合格 ${result.stats.failingCount} 个 · 核验依据版本 ${result.basisVersion}</span>
    </div>
    ${globalErrs}${itemErrs}
    ${result.eligible ? '' : (fail || '<div class="small-muted">所有节点均满足授权要求（但可能存在上方全局错误）。</div>')}
    ${actionArea}`;

  if (mode === 'publish' && result.eligible) {
    $('#publishBtn').addEventListener('click', () => doPublish(formData, result.basisVersion));
  }
}

async function doPublish(formData, basisVersion) {
  if (!formData.packageId) { toast('请先「保存待发布包」，再发布', true); return; }
  try {
    const r = await api('POST', `/api/packages/${formData.packageId}/publish`, { basisVersion });
    toast(`发布成功，不可变快照 #${r.snapshotId} 已保存`);
    await loadState();
    fillPkgForm({});
    openSnapshot(r.snapshotId);
  } catch (err) {
    if (err.status === 409 && err.details && err.details.code === 'STALE_BASIS') {
      toast(`依据过期被拒绝：${err.message} 请点「核验」后重试发布。`, true);
      await loadState();
    } else if (err.status === 422 && err.data && err.data.details && err.data.details.result) {
      toast('核验未通过，已拒绝发布（本次核验记录已留存为快照）', true);
      await loadState();
      renderVerify(err.data.details.result, formData);
    } else toast(errText(err), true);
  }
}

// ---- 包列表 ----
const STATUS_TEXT = { draft: '待发布', published: '已发布', needs_review: '需复核' };

function renderPackages() {
  const box = $('#packagesList');
  if (!state.packages.length) { box.innerHTML = '<div class="small-muted">还没有展览包。</div>'; return; }
  box.innerHTML = state.packages.map((p) => `
    <div class="panel" data-id="${p.id}">
      <div class="pkg-head">
        <h3>${esc(p.name)} <span class="small-muted">#${p.id}</span>
          <span class="pill ${p.status === 'published' ? 'pill-ok' : p.status === 'needs_review' ? 'pill-bad' : 'pill-neutral'}">${STATUS_TEXT[p.status]}</span>
        </h3>
        <div class="pkg-actions">
          ${p.status === 'draft' ? `<button class="btn btn-small" data-act="edit">编辑</button>` : ''}
          ${p.status === 'draft' ? `<button class="btn btn-small btn-primary" data-act="to-verify">去核验</button>` : ''}
          ${p.status === 'needs_review' ? `<button class="btn btn-small btn-primary" data-act="recheck">重新核验（人工复核）</button>` : ''}
          <button class="btn btn-small" data-act="snapshot">查看最新快照</button>
          <button class="btn btn-small" data-act="copy">复制为待发布包</button>
          ${p.status === 'draft' ? `<button class="btn btn-small btn-danger" data-act="del">删除</button>` : ''}
        </div>
      </div>
      <div class="pkg-meta">
        媒介：${esc(p.medium)} ｜ 地区：${esc(p.region)} ｜ 使用期：${p.useFrom} → ${p.useTo}
        ｜ 素材 ${p.itemCount} 项
        ${p.publishedAt ? `｜ 发布于 ${p.publishedAt.slice(0, 19).replace('T', ' ')}` : ''}
      </div>
      <div class="pkg-meta" style="margin-top:4px">
        素材：${p.items.map((i) => esc(i.title)).join('、')}
      </div>
      ${p.latestSnapshot ? `<div class="small-muted" style="margin-top:4px">
        最新快照 #${p.latestSnapshot.id}（${{ publish: '发布', review: '自动复核', recheck: '人工复核' }[p.latestSnapshot.kind]}，
        依据版本 ${p.latestSnapshot.basisVersion}，${p.latestSnapshot.eligible ? '当时合格' : '当时不合格'}，
        ${p.latestSnapshot.createdAt.slice(0, 19).replace('T', ' ')}）— 发布快照 ${p.publishSnapshotId ? `#${p.publishSnapshotId}` : '无'} 始终保留
      </div>` : ''}
    </div>`).join('');
}

$('#packagesList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.panel').dataset.id);
  const pkg = state.packages.find((x) => x.id === id);
  try {
    if (btn.dataset.act === 'edit' || btn.dataset.act === 'to-verify') {
      const full = await api('GET', `/api/packages/${id}`);
      fillPkgForm(full);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (btn.dataset.act === 'to-verify') {
        const result = await api('POST', '/api/verify', { packageId: id });
        renderVerify(result, readPkgForm());
      }
    } else if (btn.dataset.act === 'snapshot') {
      await openSnapshot(pkg.latestSnapshot.id);
    } else if (btn.dataset.act === 'copy') {
      const copy = await api('POST', `/api/packages/${id}/copy`);
      await loadState();
      fillPkgForm(copy);
      toast('已复制为新的待发布包');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (btn.dataset.act === 'recheck') {
      const r = await api('POST', `/api/packages/${id}/recheck`);
      await loadState();
      renderVerify(r.result, { packageId: id }, 'recheck');
      toast(r.message, !r.restored);
    } else if (btn.dataset.act === 'del') {
      if (!confirm('删除该待发布包？')) return;
      await api('DELETE', `/api/packages/${id}`);
      await loadState();
      toast('已删除');
    }
  } catch (err) { toast(errText(err), true); }
});

// ---- 快照弹层 ----
async function openSnapshot(snapshotId) {
  try {
    const s = await api('GET', `/api/snapshots/${snapshotId}`);
    $('#modalTitle').textContent =
      `核验快照 #${s.id}（${{ publish: '发布', review: '自动复核', recheck: '人工复核' }[s.kind]}）— 不可变`;
    const p = s.payload;
    $('#modalBody').innerHTML = `
      <div class="verdict ${s.eligible ? 'pass' : 'fail'}">
        ${s.eligible ? '该快照记录的核验结果：合格' : '该快照记录的核验结果：不合格'}
        <span class="sub">生成于 ${s.createdAt} ｜ 依据版本 ${s.basisVersion} ｜ 媒介 ${esc(p.request.medium)} ｜ 地区 ${esc(p.request.region)} ｜ 使用期 ${p.request.useFrom} → ${p.request.useTo}</span>
      </div>
      <div class="section-title">冻结素材清单（入展品 ID：${p.request.materialIds.join(', ') || '空'}）</div>
      <table class="auth">
        <tr><th>节点</th><th>结论</th><th>命中授权</th><th>路径数</th></tr>
        ${p.nodes.map((n) => `
          <tr>
            <td>${esc(n.title)}${n.isRoot ? ' <span class="small-muted">（入展品）</span>' : ''}</td>
            <td>${n.eligible ? '<span class="pill pill-ok">合格</span>' : n.reasonText.map((t) => `<span class="pill pill-bad">${esc(t)}</span>`).join(' ')}</td>
            <td>${n.matchedAuthorization ? `#${n.matchedAuthorization.id}（${esc(n.matchedAuthorization.media)}/${esc(n.matchedAuthorization.region)}，${n.matchedAuthorization.validFrom}→${n.matchedAuthorization.validTo}）` : '<span class="small-muted">—</span>'}</td>
            <td>${n.paths.length}</td>
          </tr>`).join('')}
      </table>
      <div class="section-title">快照原始 JSON</div>
      <pre class="json">${esc(JSON.stringify(p, null, 2))}</pre>`;
    $('#modalBackdrop').classList.remove('hidden');
  } catch (err) { toast(errText(err), true); }
}
$('#modalClose').addEventListener('click', () => $('#modalBackdrop').classList.add('hidden'));
$('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') $('#modalBackdrop').classList.add('hidden'); });

loadState().catch((e) => toast('初始化失败：' + e.message, true));
