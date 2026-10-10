import * as THREE from 'three';
import { mergeByMaterial } from '../utils/MergeUtils.js';

/**
 * 古建屋顶构件（接口契约）
 *
 * 所有函数只生成视觉几何，不注册碰撞（屋顶都在玩家头顶以上）。
 * lib 为 TextureLibrary 实例，材质一律通过 lib.material(name, params) 获取（共享、不可在此 dispose）。
 * 本模块自己创建的几何体挂在返回的 group 上，由调用方 PalaceBuilder.dispose 统一释放；
 * 自建材质（屋脊琉璃、宝顶鎏金）登记在 group.userData.ownedMaterials，由调用方释放。
 *
 * 屋面做法：屋面按"等高线多边形族"参数化 —— t=0 为屋脊（或攒尖顶点/腰檐上沿），t=1 为檐口，
 * 每个 t 对应一圈水平多边形，各坡面在角部共用同一条角脊线，因而四坡相交处无裂缝。
 * 剖面 Y(t) 为"举折"凹曲线（脊部陡、檐部缓）；檐口段叠加角部起翘与平面出冲（翼角）。
 */

const { clamp, lerp } = THREE.MathUtils;

/* ------------------------------------------------------------------ */
/* 材质与公共参数                                                        */
/* ------------------------------------------------------------------ */

function makeCtx(lib, detail = 'high') {
  const ridge = new THREE.MeshStandardMaterial({ color: 0xc98f2c, roughness: 0.36, metalness: 0.05 });
  ridge.name = 'roof_ridge_glaze';
  const gold = new THREE.MeshStandardMaterial({ color: 0xe2b048, roughness: 0.28, metalness: 0.8 });
  gold.name = 'roof_finial_gold';
  const hd = detail !== 'low';
  return {
    hd,
    mat: {
      tile: lib.material('roof_tile'),
      rafters: lib.material('rafters'),
      dougong: lib.material('dougong_band'),
      caihua: lib.material('caihua_beam'),
      wood: lib.material('wood_column'),
      wall: lib.material('wall_red'),
      ridge,
      gold,
    },
    tile: {
      tile: lib.tileSize('roof_tile'),
      rafters: lib.tileSize('rafters'),
      wood: lib.tileSize('wood_column'),
      wall: lib.tileSize('wall_red'),
    },
    aspect: { dougong: lib.aspect('dougong_band'), caihua: lib.aspect('caihua_beam') },
    seg: hd
      ? { nT: 18, nU: 26, tube: 28, radial: 6, lathe: 12 }
      : { nT: 6, nU: 10, tube: 8, radial: 4, lathe: 6 },
    owned: [ridge, gold],
  };
}

const defaultOverhang = (w, d) => clamp(Math.min(w, d) * 0.12, 1.2, 4);

function add(group, geometry, material) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

/** 举折剖面：t=0 屋脊 → 1，t=1 檐口 → 0；a 越小越凹（脊部越陡） */
const profile = a => t => {
  const q = 1 - t;
  return a * q + (1 - a) * q * q;
};

/** 平面多边形：4 → 矩形（半宽 hx、半深 hz）；8 → 正八边形（边心距 hx/hz，边与坐标轴平行） */
function polyCorners(sides, hx, hz) {
  if (sides === 8) {
    const k = 1 / Math.cos(Math.PI / 8);
    const out = [];
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + i * Math.PI / 4;
      out.push([Math.cos(a) * hx * k, Math.sin(a) * hz * k]);
    }
    return out;
  }
  return [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
}

/* ------------------------------------------------------------------ */
/* 几何工具                                                             */
/* ------------------------------------------------------------------ */

/**
 * 规则网格（rows×cols 个四边形）。sample(a, b) 返回 { p:[x,y,z], uv:[u,v] }，a、b ∈ [0,1]。
 * 按总面积向量与 expect 比较自动确定三角形朝向。
 */
function gridGeometry(rows, cols, sample, expect) {
  const W = cols + 1;
  const count = (rows + 1) * W;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let k = 0;
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++, k++) {
      const r = sample(i / rows, j / cols);
      pos[k * 3] = r.p[0]; pos[k * 3 + 1] = r.p[1]; pos[k * 3 + 2] = r.p[2];
      uv[k * 2] = r.uv[0]; uv[k * 2 + 1] = r.uv[1];
    }
  }
  const index = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  }
  orient(index, pos, expect);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

function orient(index, pos, expect) {
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    ax += uy * vz - uz * vy; ay += uz * vx - ux * vz; az += ux * vy - uy * vx;
  }
  if (ax * expect[0] + ay * expect[1] + az * expect[2] < 0) {
    for (let i = 0; i < index.length; i += 3) {
      const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t;
    }
  }
}

/** 多边形面片集合：items = [{ pts: [[x,y,z]×3|4], uvs: [[u,v]...], n: [nx,ny,nz] }]，每片按 n 定朝向，平面法线 */
function polysGeometry(items) {
  const pos = [], uv = [], index = [];
  for (const { pts, uvs, n } of items) {
    const base = pos.length / 3;
    pts.forEach(p => pos.push(p[0], p[1], p[2]));
    uvs.forEach(t => uv.push(t[0], t[1]));
    const tri = pts.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2];
    const [p0, p1, p2] = [pts[tri[0]], pts[tri[1]], pts[tri[2]]];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const dot = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
    for (let i = 0; i < tri.length; i += 3) {
      if (dot >= 0) index.push(base + tri[i], base + tri[i + 1], base + tri[i + 2]);
      else index.push(base + tri[i], base + tri[i + 2], base + tri[i + 1]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** 多边形棱柱侧面（朝外）。uvSpec: { tile } 真实米数平铺；{ band } 带状贴图（U 每 band 米重复一次，V 覆盖整个高度） */
function prismGeometry(poly, y0, y1, uvSpec) {
  const items = [];
  let per = 0;
  for (let k = 0; k < poly.length; k++) {
    const A = poly[k], B = poly[(k + 1) % poly.length];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
    let nx = (B[1] - A[1]) / len, nz = -(B[0] - A[0]) / len;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    let u0, u1, v0, v1;
    if (uvSpec.band) {
      u0 = per / uvSpec.band; u1 = (per + len) / uvSpec.band; v0 = 0; v1 = 1;
    } else {
      u0 = per / uvSpec.tile; u1 = (per + len) / uvSpec.tile; v0 = y0 / uvSpec.tile; v1 = y1 / uvSpec.tile;
    }
    items.push({
      pts: [[A[0], y0, A[1]], [B[0], y0, B[1]], [B[0], y1, B[1]], [A[0], y1, A[1]]],
      uvs: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
      n: [nx, 0, nz],
    });
    per += len;
  }
  return polysGeometry(items);
}

/** 凸多边形水平面（扇形三角化），down=true 时法线朝下 */
function fanGeometry(poly, y, tile, down = true) {
  const items = [];
  for (let k = 0; k < poly.length; k++) {
    const A = poly[k], B = poly[(k + 1) % poly.length];
    items.push({
      pts: [[0, y, 0], [A[0], y, A[1]], [B[0], y, B[1]]],
      uvs: [[0, 0], [A[0] / tile, A[1] / tile], [B[0] / tile, B[1] / tile]],
      n: [0, down ? -1 : 1, 0],
    });
  }
  return polysGeometry(items);
}

/**
 * 竖直面板（位于 x = const 平面），上沿为折线 top = [[z, y]...]（z 递增），下沿为水平 yb。
 * 用于山花、硬山山墙、墙帽端头。
 */
function gablePanel(x, top, yb, sign, tile) {
  const items = [];
  for (let i = 0; i + 1 < top.length; i++) {
    const [z0, y0] = top[i], [z1, y1] = top[i + 1];
    items.push({
      pts: [[x, yb, z0], [x, yb, z1], [x, y1, z1], [x, y0, z0]],
      uvs: [[z0 / tile, yb / tile], [z1 / tile, yb / tile], [z1 / tile, y1 / tile], [z0 / tile, y0 / tile]],
      n: [sign, 0, 0],
    });
  }
  return polysGeometry(items);
}

function tubeGeometry(points, radius, ctx) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
  return new THREE.TubeGeometry(curve, ctx.seg.tube, radius, ctx.seg.radial, false);
}

/* ------------------------------------------------------------------ */
/* 屋面（等高线多边形族）                                                */
/* ------------------------------------------------------------------ */

/**
 * @param spec.corners t => [[x,z]...] 该 t 处的水平多边形（各 t 顶点数相同、顺序一致）
 * @param spec.edges [{ k, t0, t1 }] 生成哪些坡面（第 k 条边：顶点 k → k+1）及其 t 范围
 * @param spec.Y t => y 剖面高度（不含起翘）
 * @param spec.tw 檐柱（墙）线对应的 t；t>tw 为出檐段，起翘只作用于出檐段，椽子底面从这里开始
 * @param spec.lift { L 起翘高度, O 出冲距离, D 角部影响范围（米） }
 * @param spec.th 檐口厚度（屋面与椽底的竖向距离）
 */
function hipSurface(ctx, g, spec) {
  const { corners, edges, Y, tw, lift, th, soffit = true } = spec;
  const nT = spec.nT ?? ctx.seg.nT;
  const nU = spec.nU ?? ctx.seg.nU;
  const C1 = corners(1);
  const n = C1.length;
  const T = [], N = [];
  for (let k = 0; k < n; k++) {
    const A = C1[k], B = C1[(k + 1) % n];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const tx = (B[0] - A[0]) / len, tz = (B[1] - A[1]) / len;
    let nx = tz, nz = -tx;
    if (nx * (A[0] + B[0]) + nz * (A[1] + B[1]) < 0) { nx = -nx; nz = -nz; }
    T.push([tx, tz]);
    N.push([nx, nz]);
  }
  const dir = N.map((_, c) => {
    const p = N[(c - 1 + n) % n], q = N[c];
    const x = p[0] + q[0], z = p[1] + q[1], l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  });
  // 每条边沿坡弧长表（用于 V 坐标：瓦垄从脊到檐按真实米数平铺）
  const M = 64;
  const rho = (k, t) => {
    const C = corners(t), A = C[k], B = C[(k + 1) % n];
    return ((A[0] + B[0]) * N[k][0] + (A[1] + B[1]) * N[k][1]) / 2;
  };
  const arcs = N.map((_, k) => {
    const S = [0];
    let pr = rho(k, 0), py = Y(0);
    for (let i = 1; i <= M; i++) {
      const t = i / M, r = rho(k, t), y = Y(t);
      S.push(S[i - 1] + Math.hypot(r - pr, y - py));
      pr = r; py = y;
    }
    return S;
  });
  const arcAt = (k, t) => {
    const f = clamp(t, 0, 1) * M, i = Math.min(M - 1, Math.floor(f));
    return lerp(arcs[k][i], arcs[k][i + 1], f - i);
  };

  const point = (k, t, s, yOff = 0) => {
    const C = corners(t), A = C[k], B = C[(k + 1) % n];
    let x = A[0] + (B[0] - A[0]) * s;
    let z = A[1] + (B[1] - A[1]) * s;
    const u = x * T[k][0] + z * T[k][1];
    let y = Y(t) + yOff;
    if (lift && lift.L > 0 && t > tw) {
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const near = s < 0.5 ? k : (k + 1) % n;
      const f = (1 - Math.min((Math.min(s, 1 - s) * len) / lift.D, 1)) ** 2;
      const w = f * ((t - tw) / (1 - tw)) ** 1.6;
      x += dir[near][0] * lift.O * w;
      z += dir[near][1] * lift.O * w;
      y += lift.L * w;
    }
    return { p: [x, y, z], u };
  };
  const sParam = b => (1 - Math.cos(Math.PI * b)) / 2; // 两端（角部）加密

  const tt = ctx.tile.tile, tr = ctx.tile.rafters;
  for (const { k, t0, t1 } of edges) {
    const S1 = arcAt(k, 1);
    const rows = Math.max(2, Math.round(nT * (t1 - t0)));
    add(g, gridGeometry(rows, nU, (a, b) => {
      const t = lerp(t0, t1, a);
      const r = point(k, t, sParam(b));
      return { p: r.p, uv: [r.u / tt, (S1 - arcAt(k, t)) / tt] };
    }, [0, 1, 0]), ctx.mat.tile);
    if (soffit) {
      const ta = Math.max(t0, tw);
      const rs = Math.max(2, Math.round(nT * (1 - ta) * 1.5));
      add(g, gridGeometry(rs, nU, (a, b) => {
        const t = lerp(ta, 1, a);
        const r = point(k, t, sParam(b), -th);
        return { p: r.p, uv: [r.u / tr, (S1 - arcAt(k, t)) / tr] };
      }, [0, -1, 0]), ctx.mat.rafters);
      // 檐口立面（连檐 / 椽头）
      add(g, gridGeometry(1, nU, (a, b) => {
        const r = point(k, 1, sParam(b), a ? -th * 1.5 : 0.03);
        return { p: r.p, uv: [r.u / tr, a * th * 1.5 / tr] };
      }, [N[k][0], 0, N[k][1]]), ctx.mat.rafters);
    }
  }
  /** 角脊线：角点 c 从 t0 到 1 的折线（含起翘），抬高 yOff */
  const hipLine = (c, t0, yOff, steps = ctx.seg.tube) => {
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(point(c, lerp(t0, 1, i / steps), 0, yOff).p);
    return pts;
  };
  return { point, hipLine, N, dir, n };
}

/* ------------------------------------------------------------------ */
/* 屋脊饰件                                                             */
/* ------------------------------------------------------------------ */

/** 正吻（鸱吻）：剖面挤出，x 正向朝外（远离正脊中心），口部朝内吞脊，尾部上卷 */
function chiwenGeometry(h) {
  const s = new THREE.Shape();
  s.moveTo(-0.44, 0);
  s.lineTo(0.36, 0);
  s.lineTo(0.40, 0.5);
  s.quadraticCurveTo(0.54, 0.86, 0.30, 0.99);
  s.quadraticCurveTo(0.08, 1.06, 0.02, 0.86);
  s.quadraticCurveTo(-0.01, 0.70, 0.16, 0.72);
  s.lineTo(-0.16, 0.62);
  s.lineTo(-0.28, 0.48);
  s.lineTo(-0.52, 0.36);
  s.lineTo(-0.34, 0.25);
  s.lineTo(-0.48, 0.12);
  s.lineTo(-0.44, 0);
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.26, bevelEnabled: false, curveSegments: 4 });
  geo.translate(0, 0, -0.13);
  geo.scale(h, h, h);
  return geo;
}

function addChiwen(ctx, g, x, y, h, mirror) {
  const body = add(g, chiwenGeometry(h), ctx.mat.ridge);
  body.position.set(x, y, 0);
  if (mirror) body.scale.x = -1;
  // 剑把
  const sword = add(g, new THREE.BoxGeometry(h * 0.07, h * 0.3, h * 0.07), ctx.mat.ridge);
  sword.position.set(x + (mirror ? 1 : -1) * -0.06 * h, y + h * 0.98, 0);
  sword.rotation.z = (mirror ? -1 : 1) * 0.25;
}

/** 正脊（含两端吻兽），沿 X 从 -half 到 half，脊身底部 yBase */
function addMainRidge(ctx, g, half, yBase, hr, chiwenH) {
  const hR = hr * 3.4, wR = hr * 2.2;
  const ridge = add(g, new THREE.BoxGeometry(half * 2 + hr * 2, hR, wR), ctx.mat.ridge);
  ridge.position.y = yBase + hR / 2;
  // 脊顶圆筒（当沟）增加体积感
  const cap = add(g, new THREE.CylinderGeometry(wR * 0.42, wR * 0.42, half * 2 + hr * 2, ctx.seg.radial), ctx.mat.ridge);
  cap.rotation.z = Math.PI / 2;
  cap.position.y = yBase + hR;
  if (ctx.hd && chiwenH > 0) {
    addChiwen(ctx, g, half - chiwenH * 0.12, yBase + hR * 0.25, chiwenH, false);
    addChiwen(ctx, g, -half + chiwenH * 0.12, yBase + hR * 0.25, chiwenH, true);
  }
  return yBase + hR + wR * 0.42;
}

/** 角脊（含端部仔角梁上挑）+ 末端小兽 */
function addHip(ctx, g, pts, r, beasts) {
  const last = pts[pts.length - 1], prev = pts[pts.length - 3] ?? pts[0];
  const dx = last[0] - prev[0], dz = last[2] - prev[2], l = Math.hypot(dx, dz) || 1;
  const tip = [last[0] + dx / l * r * 3, last[1] + r * 1.6, last[2] + dz / l * r * 3];
  add(g, tubeGeometry([...pts, tip], r, ctx), ctx.mat.ridge);
  if (!ctx.hd || beasts <= 0) return;
  // 从檐角往上按弧长摆放：仙人 + 走兽
  const cum = [0];
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i], b = pts[i - 1];
    cum.push(cum[cum.length - 1] + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  const sb = r * 2.6;
  const at = d => {
    for (let i = 1; i < cum.length; i++) {
      if (cum[i] >= d) {
        const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        const a = pts[pts.length - i], b = pts[pts.length - 1 - i];
        return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
      }
    }
    return pts[0];
  };
  const yaw = Math.atan2(dx, dz);
  for (let b = 0; b <= beasts; b++) {
    const p = at(sb * 0.9 + b * sb * 1.15);
    if (b === 0) {
      const xian = add(g, new THREE.ConeGeometry(sb * 0.22, sb * 1.1, 4), ctx.mat.ridge);
      xian.position.set(p[0], p[1] + r + sb * 0.55, p[2]);
      xian.rotation.y = yaw;
    } else {
      const body = add(g, new THREE.BoxGeometry(sb * 0.32, sb * 0.6, sb * 0.5), ctx.mat.ridge);
      body.position.set(p[0], p[1] + r + sb * 0.3, p[2]);
      body.rotation.y = yaw;
      const head = add(g, new THREE.BoxGeometry(sb * 0.26, sb * 0.26, sb * 0.3), ctx.mat.ridge);
      head.position.set(p[0] - dx / l * sb * 0.18, p[1] + r + sb * 0.68, p[2] - dz / l * sb * 0.18);
      head.rotation.y = yaw;
    }
  }
}

function addFinial(ctx, g, y, hf) {
  const prof = [[0, 0], [0.5, 0], [0.5, 0.1], [0.32, 0.18], [0.46, 0.36], [0.42, 0.52], [0.2, 0.64],
    [0.3, 0.78], [0.26, 0.92], [0.08, 1.04], [0.03, 1.16], [0, 1.18]];
  const geo = new THREE.LatheGeometry(prof.map(([r, h]) => new THREE.Vector2(r * hf * 0.55, h * hf)), ctx.seg.lathe);
  const m = add(g, geo, ctx.mat.gold);
  m.position.y = y;
  return y + hf * 1.18;
}

/* ------------------------------------------------------------------ */
/* 斗拱带、天花、屋身                                                    */
/* ------------------------------------------------------------------ */

function addBrackets(ctx, g, poly, y0, minDim) {
  const bh = clamp(minDim * 0.05, 0.6, 1.8);
  add(g, prismGeometry(poly, y0, y0 + bh, { band: bh * ctx.aspect.dougong }), ctx.mat.dougong);
  return y0 + bh;
}

/* ------------------------------------------------------------------ */
/* 单层屋顶                                                             */
/* ------------------------------------------------------------------ */

function singleRoof(ctx, g, o) {
  const type = o.type ?? 'wudian';
  const W = o.width, D = o.depth;
  const sides = type === 'pavilion' && o.sides === 8 ? 8 : 4;
  const ovh = o.overhang ?? defaultOverhang(W, D);
  const height = o.height ?? Math.min(W, D) * (type === 'pavilion' ? 0.6 : type === 'gable' ? 0.4 : 0.45);
  const liftScale = o._lift ?? 1;
  const minD = Math.min(W, D);
  const footprint = polyCorners(sides, W / 2, D / 2);
  let y0 = o.baseY ?? 0;
  if (o.brackets ?? true) y0 = addBrackets(ctx, g, footprint, y0, minD);
  add(g, fanGeometry(footprint, y0, ctx.tile.rafters), ctx.mat.rafters);

  const th = clamp(ovh * 0.1, 0.15, 0.45);
  const ex = W / 2 + (type === 'gable' ? 0.3 : ovh);
  const ez = D / 2 + ovh;
  const tw = (D / 2) / ez;
  const P = profile(type === 'pavilion' ? 0.36 : type === 'gable' ? 0.62 : 0.48);
  const H = (height - th) / (1 - P(tw));
  const yb = y0 + height - H;
  const Y = t => yb + H * P(t);
  const lift = type === 'gable' ? null : {
    L: clamp(minD * 0.035, 0.3, 1.5) * liftScale,
    O: clamp(ovh * 0.35, 0.2, 1.4) * liftScale,
    D: clamp(Math.min(ex, ez) * 0.5, 1.2, 12),
  };
  const hr = clamp(minD * 0.011, 0.1, 0.42);
  const chiwenH = clamp(height * 0.18, 0.5, 3.4);
  const nBeasts = W >= 40 ? 5 : W >= 20 ? 4 : 3;
  let top = yb + H;

  if (type === 'pavilion') {
    const corners = t => polyCorners(sides, ex * t, ez * t);
    const edges = corners(1).map((_, k) => ({ k, t0: 0, t1: 1 }));
    const S = hipSurface(ctx, g, { corners, edges, Y, tw, lift, th });
    for (let c = 0; c < S.n; c++) addHip(ctx, g, S.hipLine(c, 0.02, hr * 0.6), hr, nBeasts - 1);
    top = addFinial(ctx, g, Y(0) - hr, clamp(height * 0.14, 0.5, 3));
  } else if (type === 'gable') {
    const corners = t => polyCorners(4, ex, ez * t);
    const S = hipSurface(ctx, g, { corners, edges: [{ k: 0, t0: 0, t1: 1 }, { k: 2, t0: 0, t1: 1 }], Y, tw, lift, th });
    for (let c = 0; c < 4; c++) addHip(ctx, g, S.hipLine(c, 0, hr * 0.5).map(p => [p[0] - Math.sign(p[0]) * hr * 1.2, p[1], p[2]]), hr * 0.8, ctx.hd ? 2 : 0);
    top = addMainRidge(ctx, g, ex - hr, Y(0) - hr, hr, ctx.hd ? chiwenH * 0.7 : 0);
    // 硬山山墙 + 博缝
    const steps = ctx.seg.nT;
    for (const sx of [-1, 1]) {
      const pts = [];
      for (let i = steps; i >= 0; i--) { const t = tw * i / steps; pts.push([-ez * t, Y(t) - th]); }
      for (let i = 1; i <= steps; i++) { const t = tw * i / steps; pts.push([ez * t, Y(t) - th]); }
      add(g, gablePanel(sx * W / 2, pts, y0, sx, ctx.tile.wall), ctx.mat.wall);
      const rake = [];
      for (let i = steps; i >= 0; i--) { const t = i / steps; rake.push([-ez * t, Y(t) + 0.05]); }
      for (let i = 1; i <= steps; i++) { const t = i / steps; rake.push([ez * t, Y(t) + 0.05]); }
      add(g, rakeBoard(sx * (ex + 0.02), rake, th * 2.5, sx, ctx.tile.wall), ctx.mat.wall);
    }
  } else {
    const rx = Math.max(ex - ez, W * 0.04);
    const hx = t => rx + (ex - rx) * t;
    if (type === 'xieshan') {
      const ts = 0.5;
      const G = hx(ts);
      const corners = t => polyCorners(4, Math.max(G, hx(t)), ez * t);
      const S = hipSurface(ctx, g, {
        corners, Y, tw, lift, th,
        edges: [{ k: 0, t0: 0, t1: 1 }, { k: 1, t0: ts, t1: 1 }, { k: 2, t0: 0, t1: 1 }, { k: 3, t0: ts, t1: 1 }],
      });
      for (let c = 0; c < 4; c++) {
        const pts = S.hipLine(c, 0, hr * 0.6).map(p => {
          // 垂脊段（山面以上）略向内收，避免压在博风外沿
          if (Math.abs(p[0]) <= G + 1e-3) return [p[0] - Math.sign(p[0]) * hr * 1.4, p[1], p[2]];
          return p;
        });
        addHip(ctx, g, pts, hr, nBeasts);
      }
      top = addMainRidge(ctx, g, G - hr * 1.4, Y(0) - hr, hr, chiwenH);
      // 山花（收山 δ）、博风板、博脊
      const delta = clamp(ovh * 0.12, 0.15, 0.5);
      const steps = Math.max(4, Math.round(ctx.seg.nT * ts));
      for (const sx of [-1, 1]) {
        const pts = [], rake = [];
        for (let i = steps; i >= 0; i--) { const t = ts * i / steps; pts.push([-ez * t, Y(t) - th * 0.5]); rake.push([-ez * t, Y(t) + 0.04]); }
        for (let i = 1; i <= steps; i++) { const t = ts * i / steps; pts.push([ez * t, Y(t) - th * 0.5]); rake.push([ez * t, Y(t) + 0.04]); }
        add(g, gablePanel(sx * (G - delta), pts, Y(ts) - th, sx, ctx.tile.wall), ctx.mat.wall);
        add(g, rakeBoard(sx * (G + 0.03), rake, th * 3, sx, ctx.tile.wood), ctx.mat.wood);
        const bo = add(g, new THREE.BoxGeometry(delta + hr * 2, hr * 2.4, ez * ts * 2), ctx.mat.ridge);
        bo.position.set(sx * (G - delta / 2), Y(ts) + hr * 0.6, 0);
      }
    } else {
      const corners = t => polyCorners(4, hx(t), ez * t);
      const S = hipSurface(ctx, g, { corners, Y, tw, lift, th, edges: [0, 1, 2, 3].map(k => ({ k, t0: 0, t1: 1 })) });
      for (let c = 0; c < 4; c++) addHip(ctx, g, S.hipLine(c, 0, hr * 0.6), hr, nBeasts);
      top = addMainRidge(ctx, g, rx, Y(0) - hr, hr, chiwenH);
    }
  }
  return { eaveY: yb, top };
}

/** 博风板：竖直条带，上沿折线 top（z 递增），向下 h */
function rakeBoard(x, top, h, sign, tile) {
  const items = [];
  for (let i = 0; i + 1 < top.length; i++) {
    const [z0, y0] = top[i], [z1, y1] = top[i + 1];
    items.push({
      pts: [[x, y0 - h, z0], [x, y1 - h, z1], [x, y1, z1], [x, y0, z0]],
      uvs: [[z0 / tile, 0], [z1 / tile, 0], [z1 / tile, h / tile], [z0 / tile, h / tile]],
      n: [sign, 0, 0],
    });
  }
  return polysGeometry(items);
}

/* ------------------------------------------------------------------ */
/* 重檐：下层腰檐                                                        */
/* ------------------------------------------------------------------ */

function skirtRoof(ctx, g, { sides, W, D, inset, ovh, baseY, brackets, liftScale = 1 }) {
  const footprint = polyCorners(sides, W / 2, D / 2);
  const minD = Math.min(W, D);
  let y0 = baseY;
  if (brackets) y0 = addBrackets(ctx, g, footprint, y0, minD);
  add(g, fanGeometry(footprint, y0, ctx.tile.rafters), ctx.mat.rafters);
  const hxi = W / 2 - inset, hzi = D / 2 - inset, ex = W / 2 + ovh, ez = D / 2 + ovh;
  const corners = t => polyCorners(sides, lerp(hxi, ex, t), lerp(hzi, ez, t));
  const tw = inset / (inset + ovh);
  const th = clamp(ovh * 0.1, 0.15, 0.45);
  const P = profile(0.55);
  const Hs = (inset + ovh) * 0.45;
  const yb = y0 + th - Hs * P(tw);
  const Y = t => yb + Hs * P(t);
  const lift = {
    L: clamp(minD * 0.03, 0.3, 1.3) * liftScale,
    O: clamp(ovh * 0.35, 0.2, 1.3) * liftScale,
    D: clamp((inset + ovh) * 1.6, 1.2, 10),
  };
  const nT = Math.max(4, Math.round(ctx.seg.nT * 0.6));
  const S = hipSurface(ctx, g, { corners, Y, tw, lift, th, nT, edges: footprint.map((_, k) => ({ k, t0: 0, t1: 1 })) });
  const hr = clamp(minD * 0.009, 0.1, 0.36);
  for (let c = 0; c < S.n; c++) addHip(ctx, g, S.hipLine(c, 0, hr * 0.6, Math.max(6, ctx.seg.tube >> 1)), hr, ctx.hd ? 3 : 0);
  // 围脊：腰檐与上层屋身交接处
  add(g, prismGeometry(polyCorners(sides, hxi + hr, hzi + hr), Y(0) - hr, Y(0) + hr * 1.8, { tile: 1 }), ctx.mat.ridge);
  return { y0, eaveY: yb, topY: Y(0) };
}

/* ------------------------------------------------------------------ */
/* 组合                                                                 */
/* ------------------------------------------------------------------ */

function roofInto(ctx, g, o) {
  const type = o.type ?? 'wudian';
  const layers = type === 'gable' ? 1 : (o.layers ?? 1);
  if (layers < 2) return singleRoof(ctx, g, o);
  const W = o.width, D = o.depth;
  const sides = type === 'pavilion' && o.sides === 8 ? 8 : 4;
  const ovh = o.overhang ?? defaultOverhang(W, D);
  const inset = clamp(Math.min(W, D) * 0.12, 1.2, 5);
  const sk = skirtRoof(ctx, g, { sides, W, D, inset, ovh, baseY: o.baseY ?? 0, brackets: o.brackets ?? true, liftScale: o._lift ?? 1 });
  // 上层屋身：红木身 + 额枋彩画
  const Wi = W - inset * 2, Di = D - inset * 2;
  const gap = clamp(Math.min(W, D) * 0.05, 0.8, 2.4);
  const cb = clamp(Math.min(Wi, Di) * 0.035, 0.35, 1.2);
  const bodyTop = sk.topY + gap + cb;
  add(g, prismGeometry(polyCorners(sides, Wi / 2, Di / 2), sk.y0, bodyTop - cb, { tile: ctx.tile.wood }), ctx.mat.wood);
  add(g, prismGeometry(polyCorners(sides, Wi / 2 + 0.04, Di / 2 + 0.04), bodyTop - cb, bodyTop, { band: cb * ctx.aspect.caihua }), ctx.mat.caihua);
  const upper = singleRoof(ctx, g, {
    ...o, width: Wi, depth: Di, baseY: bodyTop, overhang: undefined,
    height: o.height ?? Math.min(Wi, Di) * (type === 'pavilion' ? 0.5 : 0.4),
  });
  return { eaveY: sk.eaveY, top: upper.top };
}

function finalize(ctx, g, eaveY) {
  const merged = mergeByMaterial(g, { castShadow: true, receiveShadow: true, name: g.name });
  const used = new Set();
  merged.traverse(o => { if (o.isMesh) used.add(o.material); });
  const owned = ctx.owned.filter(m => used.has(m));
  ctx.owned.filter(m => !used.has(m)).forEach(m => m.dispose());
  const box = new THREE.Box3().setFromObject(merged);
  merged.userData = { topY: box.max.y, eaveY, ownedMaterials: owned };
  return merged;
}

/**
 * @param {import('../utils/TextureLibrary.js').TextureLibrary} lib
 * @param {object} opts
 * @param {'wudian'|'xieshan'|'pavilion'|'gable'} opts.type 庑殿 / 歇山 / 攒尖(亭) / 硬山(庑房、宫墙帽)
 * @param {number} opts.width  屋身面宽（X，檐柱外皮围合尺寸，米）
 * @param {number} opts.depth  屋身进深（Z）
 * @param {number} opts.baseY  屋身顶面高度（柱顶额枋之上），屋顶从这里开始
 * @param {number} [opts.layers=1] 1 单檐 / 2 重檐
 * @param {boolean} [opts.brackets=true] 是否在 baseY 之上加一圈斗拱带
 * @param {number} [opts.overhang] 出檐距离，默认 clamp(min(width,depth)*0.12, 1.2, 4)
 * @param {number} [opts.height] 屋顶高度（不含吻兽），默认按类型取进深的比例
 * @param {number} [opts.sides=4] 仅 pavilion：4 或 8
 * @param {'high'|'low'} [opts.detail='high'] low 用于远处背景建筑：减少分段，不生成吻兽、脊兽、椽子等小构件
 * @returns {THREE.Group} group.userData = { topY, eaveY, ownedMaterials }：最高点（含吻兽/宝顶）、最低檐口高度（均为 group 局部坐标）、需调用方释放的自建材质
 */
export function buildRoof(lib, opts) {
  const ctx = makeCtx(lib, opts.detail);
  const g = new THREE.Group();
  g.name = `roof_${opts.type ?? 'wudian'}`;
  const r = roofInto(ctx, g, opts);
  return finalize(ctx, g, r.eaveY);
}

/**
 * 宫墙顶的黄琉璃瓦墙帽，沿局部 X 轴延伸，底面位于 y=0（调用方把 group 放到墙顶）。
 * @param {object} opts
 * @param {number} opts.length 墙长
 * @param {number} opts.thickness 墙厚
 * @returns {THREE.Group} userData = { topY, ownedMaterials }
 */
export function buildWallCap(lib, { length, thickness }) {
  const ctx = makeCtx(lib, 'low');
  const g = new THREE.Group();
  g.name = 'wall_cap';
  const L = length / 2;
  const half = thickness / 2 + 0.35;
  const base = 0.32;
  const rise = half * 0.5;
  const fasciaH = 0.12;
  const P = profile(0.6);
  const nS = 4;
  const tt = ctx.tile.tile;
  // 檐下砖檐（与墙同色）
  add(g, prismGeometry(polyCorners(4, L, thickness / 2 + 0.06), 0, base - fasciaH, { tile: ctx.tile.wall }), ctx.mat.wall);
  // 两坡瓦面：U 沿墙长，V 沿坡弧长（瓦垄顺坡）
  const prof = [];
  let arc = 0;
  for (let i = 0; i <= nS; i++) {
    const t = i / nS;
    const z = half * t, y = base + rise * P(t);
    if (i) arc += Math.hypot(z - prof[i - 1][0], y - prof[i - 1][1]);
    prof.push([z, y, arc]);
  }
  for (const sz of [-1, 1]) {
    add(g, gridGeometry(nS, 1, (a, b) => {
      const [z, y, s] = prof[Math.round(a * nS)];
      const x = lerp(-L, L, b);
      return { p: [x, y, sz * z], uv: [x / tt, (arc - s) / tt] };
    }, [0, 1, 0]), ctx.mat.tile);
    // 檐口立面与檐底
    add(g, polysGeometry([
      { pts: [[-L, base - fasciaH, sz * half], [L, base - fasciaH, sz * half], [L, base + 0.02, sz * half], [-L, base + 0.02, sz * half]],
        uvs: [[-L / tt, 0], [L / tt, 0], [L / tt, 0.04], [-L / tt, 0.04]], n: [0, 0, sz] },
      { pts: [[-L, base - fasciaH, sz * (thickness / 2)], [L, base - fasciaH, sz * (thickness / 2)], [L, base - fasciaH, sz * half], [-L, base - fasciaH, sz * half]],
        uvs: [[-L / tt, 0], [L / tt, 0], [L / tt, 0.1], [-L / tt, 0.1]], n: [0, -1, 0] },
    ]), ctx.mat.tile);
  }
  // 端头山面
  for (const sx of [-1, 1]) {
    const pts = [];
    for (let i = nS; i >= 0; i--) pts.push([-prof[i][0], prof[i][1]]);
    for (let i = 1; i <= nS; i++) pts.push([prof[i][0], prof[i][1]]);
    add(g, gablePanel(sx * L, pts, base - fasciaH, sx, ctx.tile.wall), ctx.mat.wall);
  }
  // 屋脊
  const rh = clamp(thickness * 0.12, 0.18, 0.4);
  const ridge = add(g, new THREE.BoxGeometry(length, rh, rh * 1.1), ctx.mat.ridge);
  ridge.position.y = base + rise + rh * 0.3;
  const merged = finalize(ctx, g, base);
  merged.userData.topY = base + rise + rh * 0.8;
  return merged;
}

/**
 * 紫禁城角楼（三重檐、十字脊、多折角的简化版），底面中心在原点，放到城墙转角顶部。
 * 构成：下层方形楼身 + 腰檐 → 中层十字形抱厦（四面歇山山花朝外）→ 上层十字脊歇山 + 鎏金宝顶。
 * @param {object} opts
 * @param {number} opts.size 平面边长（米）
 * @returns {THREE.Group} userData = { topY, eaveY, ownedMaterials }
 */
export function buildCornerTower(lib, { size = 12 } = {}) {
  const ctx = makeCtx(lib, 'high');
  ctx.seg = { nT: 10, nU: 14, tube: 12, radial: 5, lathe: 10 };
  const s = size;
  const g = new THREE.Group();
  g.name = 'corner_tower';

  // 白石台基
  const plinthH = s * 0.05;
  add(g, prismGeometry(polyCorners(4, s * 0.47, s * 0.47), 0, plinthH, { tile: 2 }), lib.material('marble'));
  add(g, fanGeometry(polyCorners(4, s * 0.47, s * 0.47), plinthH, 2, false), lib.material('marble'));

  // 第一层：方形楼身 + 腰檐（第一重檐）
  const W1 = s * 0.8;
  const h1 = plinthH + s * 0.26;
  add(g, prismGeometry(polyCorners(4, W1 / 2, W1 / 2), plinthH, h1 - s * 0.04, { tile: ctx.tile.wood }), ctx.mat.wood);
  add(g, prismGeometry(polyCorners(4, W1 / 2 + 0.03, W1 / 2 + 0.03), h1 - s * 0.04, h1, { band: s * 0.04 * ctx.aspect.caihua }), ctx.mat.caihua);
  const sk = skirtRoof(ctx, g, { sides: 4, W: W1, D: W1, inset: s * 0.1, ovh: s * 0.08, baseY: h1, brackets: false, liftScale: 1.6 });

  // 第二层：十字形抱厦，四面山花朝外（第二重檐）
  const armW = s * 0.42, armL = s * 0.88;
  const h2 = sk.topY + s * 0.16;
  for (const rot of [0, Math.PI / 2]) {
    const sub = new THREE.Group();
    sub.rotation.y = rot;
    add(sub, prismGeometry(polyCorners(4, armL / 2 - s * 0.06, armW / 2), sk.y0, h2, { tile: ctx.tile.wood }), ctx.mat.wood);
    roofInto(ctx, sub, { type: 'xieshan', width: armL - s * 0.12, depth: armW, baseY: h2, brackets: true, overhang: s * 0.07, height: s * 0.2, _lift: 2.2 });
    g.add(sub);
  }

  // 第三层：中心楼身升起，十字脊歇山（第三重檐）+ 宝顶
  const core = s * 0.5;
  const midTop = h2 + clamp(armW * 0.05, 0.6, 1.8) + s * 0.2;
  const h3 = midTop + s * 0.1;
  add(g, prismGeometry(polyCorners(4, core / 2, core / 2), h2, h3 - s * 0.035, { tile: ctx.tile.wood }), ctx.mat.wood);
  add(g, prismGeometry(polyCorners(4, core / 2 + 0.03, core / 2 + 0.03), h3 - s * 0.035, h3, { band: s * 0.035 * ctx.aspect.caihua }), ctx.mat.caihua);
  let top = h3;
  for (const rot of [0, Math.PI / 2]) {
    const sub = new THREE.Group();
    sub.rotation.y = rot;
    const r = roofInto(ctx, sub, { type: 'xieshan', width: core * 1.25, depth: core * 0.62, baseY: h3, brackets: true, overhang: s * 0.07, height: s * 0.22, _lift: 2.2 });
    top = Math.max(top, r.top);
    g.add(sub);
  }
  addFinial(ctx, g, top - s * 0.02, s * 0.09);
  return finalize(ctx, g, sk.eaveY);
}
