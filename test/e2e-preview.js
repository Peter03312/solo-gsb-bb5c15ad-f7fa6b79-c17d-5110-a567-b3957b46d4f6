'use strict';

// 影响预演 / 确认 API 端到端自检（针对运行中的 http://localhost:3000）
// 与 test/e2e.js 相互独立；运行：node test/e2e-preview.js
const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  // 演示数据：包 #1「常设展」已发布且合格（basisVersion=10）；授权 #1=film、#3=footage 有效授权

  console.log('P1) 预演只读：撤销授权 #1 不改库');
  {
    const s0 = await call('GET', '/api/state');
    const pre = await call('POST', '/api/preview/impact', { op: 'authz_revoke', authorizationId: 1 });
    ok(pre.status === 200 && pre.data.dryRun === true, '预演 200 dryRun');
    ok(pre.data.basisVersion === s0.data.basisVersion, '给出依据版本');
    ok(pre.data.affectedCount === 1 && pre.data.affectedPackages[0].packageId === 1,
      '仅列出将由合格转不合格的已发布包 #1');
    const fn = pre.data.affectedPackages[0].failingNodes[0];
    ok(fn.materialId === 1 && fn.reasons.includes('revoked'), '问题节点 film / 原因 revoked');
    ok(typeof pre.data.impactFingerprint === 'string' && pre.data.impactFingerprint.length === 64,
      '返回 sha256 影响指纹');
    const s1 = await call('GET', '/api/state');
    ok(s1.data.basisVersion === s0.data.basisVersion, '依据版本未变');
    const pkg = await call('GET', '/api/packages/1');
    ok(pkg.data.status === 'published' && pkg.data.snapshots.length === 1, '包状态/快照均未变');
  }

  console.log('P2) 指纹不一致 -> 409 IMPACT_MISMATCH，无写入');
  {
    const pre = await call('POST', '/api/preview/impact', { op: 'authz_delete', authorizationId: 3 });
    const c = await call('POST', '/api/preview/confirm', {
      op: 'authz_delete', authorizationId: 3,
      basisVersion: pre.data.basisVersion, impactFingerprint: '0'.repeat(64),
    });
    ok(c.status === 409 && c.data.details.code === 'IMPACT_MISMATCH', '409 IMPACT_MISMATCH');
    const m = await call('GET', '/api/materials/3');
    ok(m.data.authorizations.some((a) => a.id === 3), '授权仍在，无部分写入');
  }

  console.log('P3) 依据过期 -> 409 STALE_BASIS 并附最新影响，无写入');
  {
    const pre = await call('POST', '/api/preview/impact', { op: 'authz_delete', authorizationId: 3 });
    await call('POST', '/api/materials/2/authorizations', {
      media: '网络', region: '中国大陆', validFrom: '2030-01-01', validTo: '2030-12-31',
    });
    const c = await call('POST', '/api/preview/confirm', {
      op: 'authz_delete', authorizationId: 3,
      basisVersion: pre.data.basisVersion, impactFingerprint: pre.data.impactFingerprint,
    });
    ok(c.status === 409 && c.data.details.code === 'STALE_BASIS', '409 STALE_BASIS');
    ok(c.data.details.currentBasis === pre.data.basisVersion + 1, 'currentBasis 已 +1');
    ok(c.data.details.impact && c.data.details.impactFingerprint, '附重算影响与新指纹');
    const m = await call('GET', '/api/materials/3');
    ok(m.data.authorizations.some((a) => a.id === 3), '授权仍在');
  }

  console.log('P4) 目标失效 / 输入非法 / 成环');
  {
    ok((await call('POST', '/api/preview/impact', { op: 'authz_delete', authorizationId: 99999 })).status === 404,
      '目标授权失效 -> 404');
    ok((await call('POST', '/api/preview/impact', { op: 'link_delete', linkId: 99999 })).status === 404,
      '目标关系失效 -> 404');
    const badDate = await call('POST', '/api/preview/impact', {
      op: 'authz_create', materialId: 1, media: '屏幕放映', region: '中国大陆',
      validFrom: '2026-12-01', validTo: '2026-01-01',
    });
    ok(badDate.status === 400, '非法日期 -> 400（沿用现有校验）');
    const cycle = await call('POST', '/api/preview/impact', { op: 'link_create', materialId: 2, sourceMaterialId: 1 });
    ok(cycle.status === 409 && cycle.data.details.cyclePath.join() === '1,2',
      '成环关系预演仍拒绝（409 + cyclePath）');
    ok((await call('POST', '/api/preview/confirm', { op: 'authz_revoke', authorizationId: 1 })).status === 400,
      '确认缺 basisVersion -> 400');
  }

  console.log('P5) 零影响变更：确认成功，不产生复核/快照');
  {
    const m = await call('POST', '/api/materials', { title: '预演孤立素材' });
    const pre = await call('POST', '/api/preview/impact', {
      op: 'authz_create', materialId: m.data.id, media: '*', region: '*',
      validFrom: '2026-01-01', validTo: '2028-12-31', licensor: 'x',
    });
    ok(pre.data.affectedCount === 0, '预演 0 包受影响');
    const c = await call('POST', '/api/preview/confirm', {
      op: 'authz_create', materialId: m.data.id, media: '*', region: '*',
      validFrom: '2026-01-01', validTo: '2028-12-31', licensor: 'x',
      basisVersion: pre.data.basisVersion, impactFingerprint: pre.data.impactFingerprint,
    });
    ok(c.status === 201 && c.data.affectedCount === 0 && c.data.newBasisVersion === pre.data.basisVersion + 1,
      '确认成功且依据版本 +1');
    ok(c.data.authorization && c.data.authorization.materialId === m.data.id,
      '返回兼容 authorization DTO');
    const pkg = await call('GET', '/api/packages/1');
    ok(pkg.data.status === 'published' && pkg.data.snapshots.length === 1, '已发布包无变化');
  }

  console.log('P6) 有影响变更：确认后变更生效 + 需复核 + 不可变快照 + 不自动恢复');
  {
    const pre = await call('POST', '/api/preview/impact', { op: 'authz_delete', authorizationId: 3 });
    ok(pre.data.affectedPackages[0].failingNodes[0].materialId === 3, '预演 footage(3) 将不合格');
    const c = await call('POST', '/api/preview/confirm', {
      op: 'authz_delete', authorizationId: 3,
      basisVersion: pre.data.basisVersion, impactFingerprint: pre.data.impactFingerprint,
    });
    ok(c.status === 201 && c.data.affectedCount === 1 && c.data.affectedPackages[0].reviewSnapshotId > 0,
      '确认成功并返回复核快照 id');
    const pkg = await call('GET', '/api/packages/1');
    ok(pkg.data.status === 'needs_review', '包标记 needs_review');
    ok(pkg.data.snapshots.map((s) => s.kind + ':' + s.eligible).join(',') === 'publish:true,review:false',
      '原发布快照保留 + 追加 review 快照');
    const m = await call('GET', '/api/materials/3');
    ok(!m.data.authorizations.some((a) => a.id === 3), '授权确已删除');

    // 补授权：预演为 0（需复核包不自动恢复），确认后仍 needs_review
    const pre2 = await call('POST', '/api/preview/impact', {
      op: 'authz_create', materialId: 3, media: '屏幕放映', region: '中国大陆',
      validFrom: '2025-01-01', validTo: '2027-12-31',
    });
    ok(pre2.data.affectedCount === 0, '补授权预演 0 影响');
    await call('POST', '/api/preview/confirm', {
      op: 'authz_create', materialId: 3, media: '屏幕放映', region: '中国大陆',
      validFrom: '2025-01-01', validTo: '2027-12-31',
      basisVersion: pre2.data.basisVersion, impactFingerprint: pre2.data.impactFingerprint,
    });
    const still = await call('GET', '/api/packages/1');
    ok(still.data.status === 'needs_review', '需复核包不自动恢复');
    // 人工复核可恢复（既有规则不变）
    const rc = await call('POST', '/api/packages/1/recheck');
    ok(rc.data.restored === true, '人工复核恢复 published');
  }

  console.log('P7) 来源关系新增预演/确认 + 并发成环确认被拒');
  {
    const a = (await call('POST', '/api/materials', { title: '预演链头' })).data;
    const b = (await call('POST', '/api/materials', { title: '预演链尾无授权' })).data;
    await call('POST', `/api/materials/${a.id}/authorizations`, {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2028-12-31',
    });
    const pk = await call('POST', '/api/packages', {
      name: '预演链包', medium: '屏幕', region: '中国大陆',
      useFrom: '2026-06-01', useTo: '2026-06-30', materialIds: [a.id],
    });
    const v = await call('POST', '/api/verify', { packageId: pk.data.id });
    await call('POST', `/api/packages/${pk.data.id}/publish`, { basisVersion: v.data.basisVersion });

    const pre = await call('POST', '/api/preview/impact', {
      op: 'link_create', materialId: a.id, sourceMaterialId: b.id, relation: '引用',
    });
    ok(pre.data.affectedPackages.some((p) => p.packageId === pk.data.id),
      '预演新增边会使该包不合格');

    // 并发：他人先插入反向边 b->a，确认时成环 -> 拒绝且无写入
    await call('POST', `/api/materials/${b.id}/sources`, { sourceMaterialId: a.id });
    const c = await call('POST', '/api/preview/confirm', {
      op: 'link_create', materialId: a.id, sourceMaterialId: b.id, relation: '引用',
      basisVersion: pre.data.basisVersion, impactFingerprint: pre.data.impactFingerprint,
    });
    ok(c.status === 409 && (/闭环/.test(c.data.error) || c.data.details.code === 'STALE_BASIS'),
      '确认时被事务拒绝（成环或依据过期），无写入');
    const ma = await call('GET', `/api/materials/${a.id}`);
    ok(!ma.data.sources.some((s) => s.sourceMaterialId === b.id), '成环边未写入（无部分写入）');
  }

  console.log(`\n预演功能自检结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
