'use strict';

// 变更影响预演 / 确认的共享核心。
//
// 预演（dry-run）：复用与现有编辑接口完全一致的字段与校验，在内存中模拟单笔授权
// 增/改/撤/删或单条来源关系增/删，只列出“因该变更将由合格转为不合格”的已发布包、
// 问题节点及原因，并给出依据版本。不写库。
//
// 确认：在单个 SQLite 事务内复查依据版本、目标有效性与输入合法性，重算影响并与
// 预演清单（impactFingerprint）比对；任一不一致则整体回滚，绝不产生部分写入。

const crypto = require('crypto');
const { nowIso } = require('./db');
const {
  isValidDate,
  loadGraph,
  findPath,
  basisVersion,
  verifyPackage,
} = require('./verify');

class OpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const str = (v) => (v === null || v === undefined ? '' : String(v));

function validateScope(medium, region) {
  medium = str(medium).trim();
  region = str(region).trim();
  if (!medium) throw new OpError(400, '媒介不能为空');
  if (!region) throw new OpError(400, '地区不能为空');
  return { medium, region };
}

function validateDateRange(from, to) {
  if (!isValidDate(from)) throw new OpError(400, `起始日期不合法：${from || '（空）'}（需为 YYYY-MM-DD）`);
  if (!isValidDate(to)) throw new OpError(400, `截止日期不合法：${to || '（空）'}（需为 YYYY-MM-DD）`);
  if (from > to) throw new OpError(400, `起止日期不合法：起始 ${from} 晚于截止 ${to}`);
}

const OP_TEXTS = {
  authz_create: '新增授权',
  authz_update: '修改授权',
  authz_revoke: '撤销授权',
  authz_delete: '删除授权',
  link_create: '新增来源关系',
  link_delete: '删除来源关系',
};

// ---------- 操作计划：校验 + 构造模拟态 + 执行写入 ----------
// 计划对象：{ op, describe(), check(db), buildOverlay(db), run(db) }
// check/buildOverlay 在预演与确认中复用，保证两处输入校验、成环判断完全一致。

function requireMaterial(db, id) {
  const m = db.prepare('SELECT * FROM materials WHERE id=?').get(id);
  if (!m) throw new OpError(404, `素材 #${id} 不存在`);
  return m;
}

function buildPlan(db, op, body = {}) {
  const ts = nowIso();

  if (op === 'authz_create') {
    const materialId = Number(body.materialId);
    requireMaterial(db, materialId);
    const { medium, region } = validateScope(body.media ?? body.medium, body.region);
    const validFrom = str(body.validFrom).trim();
    const validTo = str(body.validTo).trim();
    validateDateRange(validFrom, validTo);
    const revoked = body.revoked ? 1 : 0;
    const licensor = str(body.licensor).trim() || null;
    const note = str(body.note).trim() || null;
    return {
      op,
      describe: () => `为素材 #${materialId} 新增授权（${medium}/${region}，${validFrom}→${validTo}）`,
      buildOverlay: () => ({
        auths: db.prepare('SELECT * FROM authorizations').all().concat([{
          id: -1, material_id: materialId, media: medium, region,
          valid_from: validFrom, valid_to: validTo, revoked, licensor, note,
        }]),
        links: db.prepare('SELECT material_id, source_material_id FROM source_links').all(),
      }),
      run: (txDb) => txDb.prepare(
        `INSERT INTO authorizations(material_id, media, region, valid_from, valid_to, revoked, licensor, note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(materialId, medium, region, validFrom, validTo, revoked, licensor, note, ts, ts).lastInsertRowid,
    };
  }

  if (op === 'authz_update') {
    const id = Number(body.authorizationId);
    const a = db.prepare('SELECT * FROM authorizations WHERE id=?').get(id);
    if (!a) throw new OpError(404, `授权 #${id} 不存在`);
    const medium = str(body.media ?? a.media).trim();
    const region = str(body.region ?? a.region).trim();
    const validFrom = str(body.validFrom ?? a.valid_from).trim();
    const validTo = str(body.validTo ?? a.valid_to).trim();
    const licensor = body.licensor === undefined ? a.licensor : str(body.licensor).trim() || null;
    const note = body.note === undefined ? a.note : str(body.note).trim() || null;
    if (!medium) throw new OpError(400, '媒介不能为空');
    if (!region) throw new OpError(400, '地区不能为空');
    validateDateRange(validFrom, validTo);
    const revoked = body.revoked === undefined ? a.revoked : (body.revoked ? 1 : 0);
    return {
      op,
      describe: () => `修改授权 #${id}（${medium}/${region}，${validFrom}→${validTo}${revoked ? '，已撤销' : ''}）`,
      buildOverlay: () => ({
        auths: db.prepare('SELECT * FROM authorizations').all().map((x) =>
          x.id === id
            ? { ...x, media: medium, region, valid_from: validFrom, valid_to: validTo, revoked, licensor, note }
            : x),
        links: db.prepare('SELECT material_id, source_material_id FROM source_links').all(),
      }),
      run: (txDb) => txDb.prepare(
        `UPDATE authorizations SET media=?, region=?, valid_from=?, valid_to=?, revoked=?, licensor=?, note=?, updated_at=? WHERE id=?`
      ).run(medium, region, validFrom, validTo, revoked, licensor, note, ts, id),
    };
  }

  if (op === 'authz_revoke') {
    const id = Number(body.authorizationId);
    const a = db.prepare('SELECT * FROM authorizations WHERE id=?').get(id);
    if (!a) throw new OpError(404, `授权 #${id} 不存在`);
    return {
      op,
      describe: () => `撤销授权 #${id}`,
      buildOverlay: () => ({
        auths: db.prepare('SELECT * FROM authorizations').all().map((x) =>
          x.id === id ? { ...x, revoked: 1 } : x),
        links: db.prepare('SELECT material_id, source_material_id FROM source_links').all(),
      }),
      run: (txDb) => txDb.prepare('UPDATE authorizations SET revoked=1, updated_at=? WHERE id=?').run(ts, id),
    };
  }

  if (op === 'authz_delete') {
    const id = Number(body.authorizationId);
    const a = db.prepare('SELECT * FROM authorizations WHERE id=?').get(id);
    if (!a) throw new OpError(404, `授权 #${id} 不存在`);
    return {
      op,
      describe: () => `删除授权 #${id}`,
      buildOverlay: () => ({
        auths: db.prepare('SELECT * FROM authorizations').all().filter((x) => x.id !== id),
        links: db.prepare('SELECT material_id, source_material_id FROM source_links').all(),
      }),
      run: (txDb) => txDb.prepare('DELETE FROM authorizations WHERE id=?').run(id),
    };
  }

  if (op === 'link_create') {
    const materialId = Number(body.materialId);
    const sourceId = Number(body.sourceMaterialId);
    requireMaterial(db, materialId);
    requireMaterial(db, sourceId);
    if (!Number.isInteger(sourceId) || sourceId <= 0) throw new OpError(400, 'sourceMaterialId 不合法');
    if (materialId === sourceId) throw new OpError(400, '素材不能以自身为来源');
    const dup = db
      .prepare('SELECT id FROM source_links WHERE material_id=? AND source_material_id=?')
      .get(materialId, sourceId);
    if (dup) throw new OpError(409, '该来源关系已存在');
    // 成环预判：若 source 已能到达 material，再加 material->source 即成环（与既有编辑接口一致）
    const cyclePath = findPath(loadGraph(db), sourceId, materialId);
    if (cyclePath) {
      throw new OpError(409, '添加该来源将形成闭环（来源关系不得成环）', {
        cyclePath,
        cycle: [materialId, ...cyclePath],
      });
    }
    const relation = str(body.relation).trim() || '使用';
    return {
      op,
      describe: () => `新增来源关系：素材 #${materialId} → 来源 #${sourceId}（${relation}）`,
      buildOverlay: () => ({
        auths: db.prepare('SELECT * FROM authorizations').all(),
        links: db.prepare('SELECT material_id, source_material_id FROM source_links').all()
          .concat([{ material_id: materialId, source_material_id: sourceId }]),
      }),
      run: (txDb) => txDb.prepare(
        'INSERT INTO source_links(material_id, source_material_id, relation, created_at) VALUES (?,?,?,?)'
      ).run(materialId, sourceId, relation, ts).lastInsertRowid,
    };
  }

  if (op === 'link_delete') {
    const id = Number(body.linkId);
    const link = db.prepare('SELECT * FROM source_links WHERE id=?').get(id);
    if (!link) throw new OpError(404, `来源关系 #${id} 不存在`);
    return {
      op,
      describe: () => `删除来源关系 #${id}（素材 #${link.material_id} → 来源 #${link.source_material_id}）`,
      buildOverlay: () => {
        // 同时模拟删除该边的行 id（使用负 id 避免与真实行冲突）
        const links = db.prepare('SELECT * FROM source_links').all()
          .filter((x) => x.id !== id)
          .map((x, i) => ({ id: -(i + 1), material_id: x.material_id, source_material_id: x.source_material_id }));
        return {
          auths: db.prepare('SELECT * FROM authorizations').all(),
          links,
        };
      },
      run: (txDb) => txDb.prepare('DELETE FROM source_links WHERE id=?').run(id),
    };
  }

  throw new OpError(400, `不支持的操作类型 op=${op}`, {
    allowed: ['authz_create', 'authz_update', 'authz_revoke', 'authz_delete', 'link_create', 'link_delete'],
  });
}

// ---------- 影响计算：仅“由合格转不合格”的已发布包 ----------
function packageInput(db, pkg) {
  const materialIds = db
    .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
    .all(pkg.id)
    .map((r) => r.material_id);
  return {
    materialIds,
    medium: pkg.medium,
    region: pkg.region,
    useFrom: pkg.use_from,
    useTo: pkg.use_to,
  };
}

function computeImpact(db, plan, currentBasis) {
  const overlay = plan.buildOverlay();
  // 预演态下 verifyPackage 仍读取 meta；显式以入参 currentBasis 作为“依据版本”。
  const rows = db
    .prepare("SELECT * FROM packages WHERE status IN ('published','needs_review') ORDER BY id")
    .all();
  const affected = [];
  for (const pkg of rows) {
    const input = packageInput(db, pkg);
    const before = verifyPackage(db, input);
    const after = verifyPackage(db, { ...input, overlay });
    if (pkg.status === 'published' && before.eligible && !after.eligible) {
      affected.push({
        packageId: pkg.id,
        name: pkg.name,
        statusBefore: 'published',
        statusAfter: 'needs_review',
        failingNodes: after.failingNodes,
      });
    }
  }
  return {
    basisVersion: currentBasis,
    affectedCount: affected.length,
    affectedPackages: affected,
  };
}

// 影响清单指纹：确认时用于比对重算结果与预演结果是否一致
function impactFingerprint(impact) {
  const canonical = {
    basisVersion: impact.basisVersion,
    affectedPackages: impact.affectedPackages.map((p) => ({
      packageId: p.packageId,
      failingNodes: p.failingNodes.map((n) => ({
        materialId: n.materialId,
        reasons: n.reasons,
      })),
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ---------- 预演（只读，不写库） ----------
function preview(db, op, body) {
  const currentBasis = basisVersion(db);
  const plan = buildPlan(db, op, body);
  const impact = computeImpact(db, plan, currentBasis);
  const fingerprint = impactFingerprint(impact);
  return {
    dryRun: true,
    op,
    opText: OP_TEXTS[op],
    operation: plan.describe(),
    basisVersion: currentBasis,
    affectedCount: impact.affectedCount,
    affectedPackages: impact.affectedPackages,
    impactFingerprint: fingerprint,
    message: impact.affectedCount === 0
      ? '预演完成：该变更不会使任何已发布展览包由合格转为不合格'
      : `预演完成：该变更将使 ${impact.affectedCount} 个已发布展览包由合格转为不合格（将标记为需复核，原快照保留）`,
  };
}

// ---------- 确认：事务内版本/影响双校验 + 变更 + 重算 + 不可变快照 ----------
// revalidate 复用 verify.js 的既有规则：published 且不合格 -> needs_review + review 快照
function confirmChange(db, tx, op, body) {
  const clientBasis = Number(body.basisVersion);
  if (!Number.isInteger(clientBasis) || clientBasis < 0) {
    throw new OpError(400, '缺少或不合法的核验依据版本 basisVersion');
  }
  if (!body.impactFingerprint || typeof body.impactFingerprint !== 'string') {
    throw new OpError(400, '缺少预演影响清单指纹 impactFingerprint');
  }
  const clientFingerprint = String(body.impactFingerprint).trim().toLowerCase();

  return tx(() => {
    // 1) 事务内复查目标有效性与输入合法性（含成环）——与依据版本无关，先于版本检查
    const plan = buildPlan(db, op, body);

    // 2) 依据版本检查
    const currentBasis = basisVersion(db);
    if (clientBasis !== currentBasis) {
      // 依据已过期：给出当前数据下的最新影响，供前端刷新后再决定
      const fresh = computeImpact(db, plan, currentBasis);
      throw new OpError(409,
        `预演依据已过期：预演时版本 ${clientBasis}，当前版本 ${currentBasis}，授权或来源关系在此期间被修改。请重新预演后再确认。`,
        { code: 'STALE_BASIS', clientBasis, currentBasis, impact: fresh, impactFingerprint: impactFingerprint(fresh) });
    }

    // 3) 重算影响并与预演清单比对
    const impact = computeImpact(db, plan, currentBasis);
    const freshFingerprint = impactFingerprint(impact);
    if (freshFingerprint !== clientFingerprint) {
      throw new OpError(409,
        '预演影响清单与当前重算结果不一致，拒绝提交（无任何写入）。请重新预演后再确认。',
        { code: 'IMPACT_MISMATCH', basisVersion: currentBasis, impact, impactFingerprint: freshFingerprint });
    }

    // 4) 执行变更（触发器使 basis_version +1），再按现有规则重算并标记/追加快照
    const targetResultId = plan.run(db);
    const flagged = revalidateAfterChange(db);

    // 5) 交叉校验：实际标记集合必须与预演一致（防御性断言，不成立则整体回滚）
    const flaggedIds = flagged.map((f) => f.packageId).sort((a, b) => a - b);
    const previewIds = impact.affectedPackages.map((p) => p.packageId).sort((a, b) => a - b);
    if (flaggedIds.join(',') !== previewIds.join(',')) {
      throw new OpError(500,
        '提交后实际影响与预演清单不一致，事务已回滚（无任何写入）。请重新预演后再确认。',
        { code: 'IMPACT_CROSSCHECK_FAILED', flaggedIds, previewIds });
    }

    const newBasis = basisVersion(db);
    return {
      ok: true,
      op,
      opText: OP_TEXTS[op],
      operation: plan.describe(),
      targetId: Number.isInteger(targetResultId) && targetResultId > 0 ? targetResultId : null,
      basisVersion: currentBasis,
      newBasisVersion: newBasis,
      affectedCount: impact.affectedCount,
      affectedPackages: flagged.map((f) => ({
        packageId: f.packageId,
        name: f.name,
        statusBefore: 'published',
        statusAfter: 'needs_review',
        failingNodes: f.result.failingNodes,
        reviewSnapshotId: f.snapshotId,
      })),
      message: impact.affectedCount === 0
        ? '变更已提交：无已发布包受影响（依据版本已更新）'
        : `变更已提交：${impact.affectedCount} 个已发布包已标记为需复核并追加不可变快照，原发布快照保留；需复核包不会自动恢复`,
    };
  });
}

// 与 verify.revalidatePublished 的区别：返回 review 快照 id，供确认响应引用
function revalidateAfterChange(database) {
  const rows = database
    .prepare("SELECT * FROM packages WHERE status IN ('published','needs_review') ORDER BY id")
    .all();
  const flagged = [];
  for (const pkg of rows) {
    const input = packageInput(database, pkg);
    const result = verifyPackage(database, input);
    if (pkg.status === 'published' && !result.eligible) {
      database.prepare("UPDATE packages SET status='needs_review', updated_at=? WHERE id=?")
        .run(nowIso(), pkg.id);
      const snapId = database.prepare(
        `INSERT INTO verification_snapshots(package_id, kind, basis_version, eligible, payload, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(pkg.id, 'review', result.basisVersion, 0, JSON.stringify(result), nowIso()).lastInsertRowid;
      flagged.push({ packageId: pkg.id, name: pkg.name, result, snapshotId: snapId });
    }
  }
  return flagged;
}

module.exports = {
  OpError,
  OP_TEXTS,
  buildPlan,
  computeImpact,
  impactFingerprint,
  preview,
  confirmChange,
  revalidateAfterChange,
};
