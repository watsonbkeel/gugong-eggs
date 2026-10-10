import * as THREE from 'three';
import { CourtKit, FACE } from './palace/kit.js';

/**
 * 中轴两侧的宫殿群、院墙、庑房与可通行的门（按故宫平面格局，尺度与中轴一致地压缩）。
 *
 * 坐标：+Z 北，-X 东（面向北时右手为东）。外城墙内皮 x = ±151、z ∈ [-146, 416]。
 *
 * 东路（x < 0）：协和门 → 文华殿、文渊阁、南三所、奉先殿；景运门 → 箭亭；内左门 → 东一长街；
 *               东六宫（景仁/承乾/钟粹 · 延禧/永和/景阳）、乾东五所；宁寿宫（九龙壁、皇极门、皇极殿、宁寿宫、养性殿、乐寿堂…）；东华门。
 * 西路（x > 0）：熙和门 → 武英殿、南薰殿、慈宁花园、慈宁宫；隆宗门；内右门 → 西一长街；
 *               养心殿、西六宫（永寿/翊坤/储秀 · 太极/长春/咸福）、重华宫、建福宫、英华殿、寿康宫、寿安宫；西华门。
 * 中轴院落：太和门广场两庑与协和门/熙和门、昭德门/贞度门；太和殿院两庑与体仁阁/弘义阁、左翼门/右翼门；
 *          中左门/中右门、后左门/后右门；乾清门两侧墙与内左门/内右门；内廷东西墙与日精门/月华门、龙光门/凤彩门、基化门/端则门；
 *          御花园院墙与琼苑东门/西门、顺贞门；钦安殿（可进入）。
 */
export class SideCourts {
  constructor(scene, library) {
    this.scene = scene;
    this.library = library;
    this.kit = new CourtKit(library, 'side_courts');
    this.group = null;
  }

  build() {
    const k = this.kit;
    this.axisCourts(k);
    for (const s of [-1, 1]) this.sixPalaces(k, s);
    this.eastOuter(k);
    this.westOuter(k);
    this.ningshou(k);
    this.westNorth(k);
    this.gardenWalls(k);
    this.group = k.finish();
    this.scene.add(this.group);
    return this;
  }

  // ───────────────────────── 中轴院落 ─────────────────────────

  axisCourts(k) {
    for (const s of [-1, 1]) {
      const E = s < 0; // 东侧
      const X = s * 75;
      const gx = s * 75; // 两侧长墙
      const facing = E ? 'x+' : 'x-';
      const cx = s * 71.9; // 庑房中心线
      const gateRot = E ? FACE.east : FACE.west;

      // 长墙：午门北 → 乾清门横街，开 协和/熙和门、左翼/右翼门、景运/隆宗门
      const w1 = k.gate({ x: gx, z: -115, rot: gateRot, style: 'hall', name: E ? '协和门' : '熙和门' });
      const w2 = k.gate({ x: gx, z: -50, rot: gateRot, style: 'hall', name: E ? '左翼门' : '右翼门' });
      const w3 = k.gate({ x: gx, z: 153, rot: gateRot, style: 'hall', name: E ? '景运门' : '隆宗门' });
      k.wall(X, -146, X, 170, { h: 7, gaps: [{ at: -115, w: w1 }, { at: -50, w: w2 }, { at: 153, w: w3 }] });

      // 太和门两侧横墙 + 昭德门 / 贞度门
      const w4 = k.gate({ x: s * 48, z: -80, style: 'hall', name: E ? '昭德门' : '贞度门' });
      k.wall(s * 21.5, -80, X, -80, { h: 7, gaps: [{ at: s * 48, w: w4 }] });
      // 中和殿南横墙 + 中左门 / 中右门（墙从三台边起，三台与墙之间不留缝）
      const w5 = k.gate({ x: s * 52, z: 48, style: 'hall', name: E ? '中左门' : '中右门' });
      k.wall(s * 27.4, 48, X, 48, { h: 7, gaps: [{ at: s * 52, w: w5 }] });
      // 保和殿北横墙 + 后左门 / 后右门
      const w6 = k.gate({ x: s * 60, z: 137, name: E ? '后左门' : '后右门' });
      k.wall(s * 42.4, 137, X, 137, { h: 7, gaps: [{ at: s * 60, w: w6 }] });
      // 乾清门两侧横墙 + 内左门 / 内右门
      const w7 = k.gate({ x: s * 45, z: 170, name: E ? '内左门' : '内右门' });
      k.wall(s * 17.5, 170, X, 170, { h: 7, gaps: [{ at: s * 45, w: w7 }] });

      // 两庑（面向院内）
      for (const [z0, z1] of [[-146, -122], [-108, -88], [-79.5, -57], [-43, 6.5], [33.5, 47.5], [48.5, 136.5]]) {
        k.corridor(cx, z0, cx, z1, facing);
      }
      // 太和门两侧廊（面向南）
      for (const [x0, x1] of [[22.5, 41.2], [54.8, 74.5]]) k.corridor(s * x0, -83.1, s * x1, -83.1, 'z-');
      // 体仁阁 / 弘义阁（两层楼阁）
      k.hall({ x: s * 68.5, z: 20, rot: E ? FACE.west : FACE.east, w: 24, d: 10, pad: 1, ph: 1.2, colH: 6.5,
        roof: 'xieshan', layers: 2, name: E ? '体仁阁' : '弘义阁' });

      // 内廷东西墙：日精门/月华门、龙光门/凤彩门、基化门/端则门
      const inner = s * 40;
      const iRot = E ? FACE.east : FACE.west;
      const g1 = k.gate({ x: inner, z: 205, rot: iRot, name: E ? '日精门' : '月华门' });
      const g2 = k.gate({ x: inner, z: 248, rot: iRot, name: E ? '龙光门' : '凤彩门' });
      const g3 = k.gate({ x: inner, z: 284, rot: iRot, name: E ? '基化门' : '端则门' });
      k.wall(inner, 170, inner, 305, { h: 7, gaps: [{ at: 205, w: g1 }, { at: 248, w: g2 }, { at: 284, w: g3 }] });
      // 乾清宫两庑（东西庑，面向院内）
      for (const [z0, z1] of [[176, 199], [211, 242], [254, 278], [290, 303]]) k.corridor(s * 36.9, z0, s * 36.9, z1, E ? 'x+' : 'x-', { depth: 3.6, colH: 3.4 });

      k.region(E ? '东一长街' : '西一长街', s * 40, s * 50, 170, 305);
      k.region(E ? '景运门外' : '隆宗门外', s * 75, s * 123, 137, 176);
    }
    // 午门外朝房（东西各一排，面向御道，可进入）
    for (const s of [-1, 1]) k.corridor(s * 45, -215, s * 45, -165, s < 0 ? 'x+' : 'x-', { depth: 6, colH: 4, name: '朝房' });
    k.region('太和门广场', -75, 75, -146, -80);
    k.region('乾清门广场', -75, 75, 137, 170);
  }

  // ───────────────────────── 东西六宫 ─────────────────────────

  /** 标准六宫院：南墙正中宫门，前殿（可进入，有宝座）、后殿、东西配殿 */
  palaceCourt(k, name, cx, z0, D = 28, W = 30) {
    const gateName = name.replace(/[宫殿]$/, '门');
    const open = k.gate({ x: cx, z: z0, name: gateName });
    k.courtWalls(cx - W / 2, cx + W / 2, z0, z0 + D, [{ side: 's', at: cx, w: open }]);
    k.hall({ x: cx, z: z0 + 0.47 * D, w: 15, d: 7.5, pad: 0.8, ph: 0.6, colH: 4.2, roof: 'xieshan',
      enter: true, throne: true, name });
    k.hall({ x: cx, z: z0 + D - 4.4, w: 15, d: 6, pad: 0.6, ph: 0.45, colH: 3.8, roof: 'xieshan', map: 'hall' });
    for (const s of [-1, 1]) {
      k.hall({ x: cx + s * 11.5, z: z0 + 0.22 * D, rot: s < 0 ? FACE.west : FACE.east, w: 7, d: 4.4, pad: 0.5,
        ph: 0.45, colH: 3.4, roof: 'gable', brackets: false, map: 'hall' });
    }
    k.region(name, cx - W / 2, cx + W / 2, z0, z0 + D);
  }

  sixPalaces(k, s) {
    if (s < 0) {
      const rows = [176, 209, 242];
      ['景仁宫', '承乾宫', '钟粹宫'].forEach((n, i) => this.palaceCourt(k, n, -65, rows[i]));
      ['延禧宫', '永和宫', '景阳宫'].forEach((n, i) => this.palaceCourt(k, n, -101, rows[i]));
      // 乾东五所
      const open = k.gate({ x: -94, z: 276, name: '乾东五所' });
      k.courtWalls(-116, -72, 276, 306, [{ side: 's', at: -94, w: open }]);
      for (let i = 0; i < 5; i++) {
        k.hall({ x: -76.8 - i * 8.6, z: 292, w: 7, d: 5, pad: 0.4, ph: 0.45, colH: 3.4, roof: 'gable', brackets: false, map: 'hall' });
      }
      k.region('乾东五所', -116, -72, 276, 306);
      k.region('东二长街', -80, -86, 170, 276);
    } else {
      // 养心殿（西一长街南端，遵义门朝东）
      const open = k.gate({ x: 50, z: 184, rot: FACE.east, name: '遵义门' });
      k.courtWalls(50, 116, 174, 202, [{ side: 'xmin', at: 184, w: open }]);
      k.hall({ x: 85, z: 190, w: 22, d: 10, pad: 1, ph: 0.6, colH: 4.8, roof: 'xieshan', enter: true, throne: true, name: '养心殿' });
      k.hall({ x: 61, z: 194, rot: FACE.east, w: 9, d: 4.6, pad: 0.5, ph: 0.45, colH: 3.4, roof: 'gable', brackets: false, map: 'hall' });
      k.region('养心殿', 50, 116, 174, 202);
      const rows = [206, 239, 272];
      ['永寿宫', '翊坤宫', '储秀宫'].forEach((n, i) => this.palaceCourt(k, n, 65, rows[i]));
      ['太极殿', '长春宫', '咸福宫'].forEach((n, i) => this.palaceCourt(k, n, 101, rows[i]));
      k.region('西二长街', 80, 86, 202, 300);
    }
  }

  // ───────────────────────── 东路外朝 ─────────────────────────

  eastOuter(k) {
    // 文华殿（文华门朝南，前殿文华殿、后殿主敬殿）
    let o = k.gate({ x: -110, z: -104, style: 'hall', name: '文华门' });
    k.courtWalls(-136, -84, -104, -40, [{ side: 's', at: -110, w: o }]);
    k.hall({ x: -110, z: -80, w: 20, d: 10, pad: 1, ph: 0.9, colH: 4.8, roof: 'xieshan', enter: true, throne: true, backDoor: true, name: '文华殿' });
    k.hall({ x: -110, z: -55, w: 16, d: 8, pad: 0.8, ph: 0.6, colH: 4.2, roof: 'xieshan', enter: true, name: '主敬殿' });
    k.region('文华殿', -136, -84, -104, -40);
    // 文渊阁（藏书楼，两层）
    o = k.gate({ x: -110, z: -34, name: '文渊阁' });
    k.courtWalls(-136, -84, -34, -4, [{ side: 's', at: -110, w: o }]);
    k.hall({ x: -110, z: -17, w: 20, d: 9, pad: 0.8, ph: 0.6, colH: 6.4, roof: 'xieshan', layers: 2, name: '文渊阁', plaque: false });
    k.region('文渊阁', -136, -84, -34, -4);
    // 南三所（三座并列小院，合为一院）
    o = k.gate({ x: -110, z: 4, name: '南三所' });
    k.courtWalls(-136, -84, 4, 50, [{ side: 's', at: -110, w: o }]);
    for (const x of [-94, -110, -126]) {
      k.hall({ x, z: 22, w: 11, d: 6, pad: 0.6, ph: 0.45, colH: 3.6, roof: 'gable', brackets: false, map: 'hall' });
      k.hall({ x, z: 39, w: 11, d: 6, pad: 0.6, ph: 0.45, colH: 3.6, roof: 'gable', brackets: false, map: 'hall' });
    }
    k.region('南三所', -136, -84, 4, 50);
    // 奉先殿（工字殿：前殿可进入）
    o = k.gate({ x: -110, z: 58, style: 'hall', name: '奉先门' });
    k.courtWalls(-136, -84, 58, 128, [{ side: 's', at: -110, w: o }]);
    k.hall({ x: -110, z: 82, w: 24, d: 12, pad: 1.2, ph: 1.2, colH: 5.2, roof: 'wudian', layers: 1, enter: true, throne: true, name: '奉先殿' });
    k.hall({ x: -110, z: 110, w: 24, d: 10, pad: 1, ph: 0.9, colH: 4.6, roof: 'wudian', map: 'hall' });
    k.region('奉先殿', -136, -84, 58, 128);
    // 箭亭（敞厅，前后可穿行）
    k.hall({ x: -100, z: 153, w: 15, d: 8, pad: 1, ph: 0.6, colH: 5, roof: 'xieshan', open: true, name: '箭亭' });
    // 东华门（城台门，可出城）
    k.cityGate({ x: -155, z: -115, rot: FACE.east, name: '东华门' });
    k.region('东华门', -170, -136, -130, -100);
  }

  // ───────────────────────── 西路外朝 ─────────────────────────

  westOuter(k) {
    let o = k.gate({ x: 111, z: -104, style: 'hall', name: '武英门' });
    k.courtWalls(86, 136, -104, -40, [{ side: 's', at: 111, w: o }]);
    k.hall({ x: 111, z: -80, w: 20, d: 10, pad: 1, ph: 0.9, colH: 4.8, roof: 'xieshan', enter: true, throne: true, backDoor: true, name: '武英殿' });
    k.hall({ x: 111, z: -55, w: 16, d: 8, pad: 0.8, ph: 0.6, colH: 4.2, roof: 'xieshan', enter: true, name: '敬思殿' });
    k.region('武英殿', 86, 136, -104, -40);
    // 南薰殿
    o = k.gate({ x: 114, z: -32, name: '南薰门' });
    k.courtWalls(92, 136, -32, 10, [{ side: 's', at: 114, w: o }]);
    k.hall({ x: 114, z: -10, w: 16, d: 8, pad: 0.8, ph: 0.6, colH: 4.4, roof: 'xieshan', enter: true, name: '南薰殿' });
    k.region('南薰殿', 92, 136, -32, 10);
    // 慈宁花园（东门朝东）
    o = k.gate({ x: 88, z: 49, rot: FACE.east, name: '慈宁花园' });
    k.courtWalls(88, 148, 18, 80, [{ side: 'xmin', at: 49, w: o }]);
    k.hall({ x: 118, z: 34, w: 7, d: 7, pad: 0.6, ph: 0.6, colH: 3.8, roof: 'pavilion', open: true, name: '临溪亭' });
    k.hall({ x: 118, z: 64, w: 15, d: 8, pad: 0.8, ph: 0.6, colH: 4.6, roof: 'xieshan', layers: 2, enter: true, name: '咸若馆' });
    k.region('慈宁花园', 88, 148, 18, 80);
    // 慈宁宫（永康左门朝东，正殿重檐歇山，可进入）
    o = k.gate({ x: 88, z: 100, rot: FACE.east, style: 'hall', name: '永康左门' });
    k.courtWalls(88, 148, 86, 134, [{ side: 'xmin', at: 100, w: o }]);
    k.hall({ x: 120, z: 116, w: 26, d: 11, pad: 1, ph: 1.0, colH: 5, roof: 'xieshan', layers: 2, enter: true, throne: true, name: '慈宁宫' });
    k.region('慈宁宫', 88, 148, 86, 134);
    // 西华门
    k.cityGate({ x: 155, z: -115, rot: FACE.west, name: '西华门' });
    k.region('西华门', 136, 170, -130, -100);
    k.region('武英殿外', 75, 151, -146, -104);
  }

  // ───────────────────────── 宁寿宫（东路） ─────────────────────────

  ningshou(k) {
    const cx = -137;
    const x0 = -151, x1 = -123;
    // 南端：九龙壁 + 皇极门；西墙锡庆门
    const o1 = k.gate({ x: x1, z: 157, rot: FACE.west, style: 'hall', name: '锡庆门' });
    const o2 = k.gate({ x: cx, z: 172, style: 'hall', name: '皇极门' });
    const o3 = k.gate({ x: cx, z: 242, name: '养性门' });
    k.wall(x0, 140, x1, 140, { h: 7 });
    k.wall(x1, 140, x1, 412, { h: 7, gaps: [{ at: 157, w: o1 }] });
    k.wall(x0, 412, x1, 412, { h: 7 });
    k.wall(x0, 172, x1, 172, { h: 7, gaps: [{ at: cx, w: o2 }] });
    k.wall(x0, 242, x1, 242, { h: 7, gaps: [{ at: cx, w: o3 }] });
    this.nineDragonWall(k, cx, 145, 22);
    k.hall({ x: cx, z: 198, w: 19, d: 11, pad: 1.2, ph: 1.5, colH: 5.4, roof: 'wudian', layers: 2, enter: true, throne: true, name: '皇极殿' });
    k.hall({ x: cx, z: 226, w: 19, d: 9, pad: 1, ph: 1.0, colH: 4.8, roof: 'xieshan', enter: true, name: '宁寿宫' });
    k.hall({ x: cx, z: 258, w: 17, d: 9, pad: 1, ph: 0.9, colH: 4.6, roof: 'xieshan', enter: true, throne: true, name: '养性殿' });
    k.hall({ x: cx, z: 284, w: 17, d: 9, pad: 1, ph: 0.9, colH: 4.6, roof: 'xieshan', layers: 2, enter: true, name: '乐寿堂' });
    k.hall({ x: cx, z: 310, w: 15, d: 8, pad: 0.8, ph: 0.6, colH: 4.2, roof: 'xieshan', name: '颐和轩' });
    k.hall({ x: cx, z: 340, w: 15, d: 8, pad: 0.8, ph: 0.6, colH: 6.4, roof: 'xieshan', layers: 2, name: '景祺阁' });
    k.hall({ x: cx, z: 372, w: 12, d: 10, pad: 0.8, ph: 0.9, colH: 7.5, roof: 'xieshan', layers: 2, name: '畅音阁' });
    k.region('九龙壁', x0, x1, 140, 172);
    k.region('宁寿宫', x0, x1, 172, 242);
    k.region('养性殿·乐寿堂', x0, x1, 242, 412);
    k.region('东筒子', -116, -123, 170, 412);
  }

  /** 九龙壁：汉白玉须弥座 + 琉璃壁身（九条金龙）+ 黄琉璃顶，面朝北 */
  nineDragonWall(k, x, z, len) {
    const f = k.frame(x, z, FACE.north);
    const h = 4.2;
    k.box(f, 'sumeru_band', len + 0.6, 0.9, 1.6, 0, 0.45, 0, 'band');
    const glaze = new THREE.MeshStandardMaterial({ color: 0x1f5f7a, roughness: 0.3, metalness: 0.1, name: 'kit_glaze_blue' });
    const wave = new THREE.MeshStandardMaterial({ color: 0x2e8a6e, roughness: 0.3, metalness: 0.1, name: 'kit_glaze_green' });
    k.owned.push(glaze, wave);
    k.mesh(f, new THREE.BoxGeometry(len, h, 1.1), glaze, 0, 0.9 + h / 2, 0);
    k.mesh(f, new THREE.BoxGeometry(len - 0.2, 0.8, 1.16), wave, 0, 1.4, 0);
    const knot = new THREE.TorusKnotGeometry(0.62, 0.16, 48, 6, 2, 3);
    for (let i = 0; i < 9; i++) {
      const m = k.mesh(f, knot, k.gold, (i - 4) * (len / 9.6), 0.9 + h * 0.58 + (i % 2 ? 0.25 : -0.15), -0.62);
      m.scale.set(1.25, 0.75, 0.5);
      m.rotation.z = (i % 2 ? 1 : -1) * 0.35;
    }
    k.roof(f, { type: 'gable', width: len + 0.4, depth: 1.6, baseY: 0.9 + h, brackets: false, height: 0.7 });
    k.col(f, -len / 2, 0, -0.8, len / 2, 3, 0.8);
    k.mapRect(f, 'hall', '九龙壁', len, 1.6);
  }

  // ───────────────────────── 西路北部 ─────────────────────────

  westNorth(k) {
    let o = k.gate({ x: 94, z: 306, name: '重华门' });
    k.courtWalls(72, 116, 306, 338, [{ side: 's', at: 94, w: o }]);
    k.hall({ x: 94, z: 321, w: 18, d: 9, pad: 1, ph: 0.75, colH: 4.6, roof: 'xieshan', enter: true, throne: true, name: '重华宫' });
    k.region('重华宫', 72, 116, 306, 338);
    o = k.gate({ x: 94, z: 344, name: '建福门' });
    k.courtWalls(72, 116, 344, 374, [{ side: 's', at: 94, w: o }]);
    k.hall({ x: 94, z: 360, w: 14, d: 10, pad: 0.8, ph: 0.75, colH: 6.4, roof: 'pavilion', layers: 2, name: '延春阁' });
    k.region('建福宫花园', 72, 116, 344, 374);
    o = k.gate({ x: 94, z: 380, name: '英华门' });
    k.courtWalls(72, 116, 380, 412, [{ side: 's', at: 94, w: o }]);
    k.hall({ x: 94, z: 398, w: 18, d: 8, pad: 1, ph: 0.9, colH: 4.6, roof: 'xieshan', enter: true, name: '英华殿' });
    k.region('英华殿', 72, 116, 380, 412);
    // 寿康宫、寿安宫（西筒子以西）
    o = k.gate({ x: 135, z: 176, name: '寿康门' });
    k.courtWalls(122, 148, 176, 226, [{ side: 's', at: 135, w: o }]);
    k.hall({ x: 135, z: 196, w: 17, d: 8, pad: 1, ph: 0.75, colH: 4.6, roof: 'xieshan', enter: true, throne: true, name: '寿康宫' });
    k.hall({ x: 135, z: 216, w: 17, d: 6, pad: 0.6, ph: 0.45, colH: 3.8, roof: 'xieshan', map: 'hall' });
    k.region('寿康宫', 122, 148, 176, 226);
    o = k.gate({ x: 135, z: 232, name: '寿安门' });
    k.courtWalls(122, 148, 232, 300, [{ side: 's', at: 135, w: o }]);
    k.hall({ x: 135, z: 256, w: 17, d: 9, pad: 1, ph: 0.75, colH: 4.6, roof: 'xieshan', enter: true, name: '寿安宫' });
    k.hall({ x: 135, z: 284, w: 17, d: 6, pad: 0.6, ph: 0.45, colH: 3.8, roof: 'xieshan', map: 'hall' });
    k.region('寿安宫', 122, 148, 232, 300);
    k.region('西筒子', 116, 122, 170, 412);
  }

  // ───────────────────────── 御花园院墙与钦安殿 ─────────────────────────

  gardenWalls(k) {
    const e = k.gate({ x: -67, z: 312, rot: FACE.east, name: '琼苑东门' });
    const w = k.gate({ x: 67, z: 312, rot: FACE.west, name: '琼苑西门' });
    const n = k.gate({ x: 0, z: 395, w: 5, h: 5, name: '顺贞门' });
    k.wall(-67, 305, -10, 305, { h: 7 });
    k.wall(10, 305, 67, 305, { h: 7 });
    k.wall(-67, 395, 67, 395, { h: 7, gaps: [{ at: 0, w: n }] });
    k.wall(-67, 305, -67, 395, { h: 7, gaps: [{ at: 312, w: e }] });
    k.wall(67, 305, 67, 395, { h: 7, gaps: [{ at: 312, w }] });
    // 钦安殿：重檐，台明前后有台阶，殿门敞开可进入；殿内供台
    k.hall({ x: 0, z: 350, w: 15, d: 11, pad: 1.5, ph: 1.5, colH: 5.5, roof: 'wudian', layers: 2,
      enter: true, throne: true, backDoor: true, name: '钦安殿' });
    k.region('钦安殿', -9, 9, 340, 360);
  }

  getColliders() {
    return [...this.kit.colliders];
  }

  getWalkables() {
    return [...this.kit.walkables];
  }

  getMapItems() {
    return [...this.kit.mapItems];
  }

  getRegions() {
    return [...this.kit.regions];
  }

  /** 所有可进入房间（世界坐标：min/max/doors/cover/spawns），为后续玩法预留 */
  getRooms() {
    return [...this.kit.rooms];
  }

  update() {}

  dispose() {
    this.group?.removeFromParent();
    this.kit.dispose(this.group);
    this.group = null;
  }
}
