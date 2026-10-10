/**
 * 找金蛋 HUD：纯 DOM，不依赖 three。所有用户输入（昵称）一律用 textContent 渲染，不拼 HTML。
 *
 * 层级（与现有界面的关系）：
 *   顶部状态条 / toast 1001   —— 高于位置面板、小地图（1000），不会被盖住
 *   倒数 / 排行榜 / 闪光 9100  —— 全屏类；要高于欢迎遮罩（9000），因为局终解锁指针后遮罩会重新出现
 *   手机进房对话框 9500        —— 高于欢迎遮罩，低于加载界面（9999，加载完才会撤）
 * 布局避让：手机上避开左下摇杆、右下跳/锁视角按钮、右上小地图预览（见下方 CSS）。
 */

const STYLE_ID = 'hunt-style';
const CSS = `
.hunt-bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 1001;
  width: min(420px, calc(100vw - 300px)); min-width: 220px; box-sizing: border-box;
  display: none; align-items: stretch; gap: 8px; padding: 8px 10px;
  background: rgba(0,0,0,.62); color: #fff; border-radius: 10px; font: 14px/1.45 Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  border: 1px solid rgba(255,200,60,.35); transition: background .3s, border-color .3s; }
.hunt-bar.show { display: flex; }
.hunt-bar .hunt-text { flex: 1; min-width: 0; pointer-events: none; user-select: none; }
.hunt-bar .l1 { font-size: 15px; font-weight: bold; color: #ffd764; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hunt-bar .l2 { font-size: 14px; color: rgba(255,255,255,.92); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hunt-bar .hunt-board-btn { flex: none; min-width: 40px; min-height: 40px; padding: 0 10px; border-radius: 8px; border: 1px solid rgba(255,200,60,.6);
  background: rgba(255,200,60,.16); color: #ffd764; font-size: 14px; cursor: pointer; touch-action: manipulation; }
.hunt-bar.flash { background: rgba(120,80,0,.88); border-color: #ffd764; box-shadow: 0 0 18px rgba(255,200,60,.8); }
.hunt-bar.flash .l2 { white-space: normal; font-size: 16px; font-weight: bold; color: #fff2c0; }
.hunt-bar.bad { border-color: rgba(255,120,120,.7); }
.hunt-toast-box { position: fixed; top: 76px; right: 20px; z-index: 1001; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; pointer-events: none; }
.hunt-toast { background: rgba(0,0,0,.72); color: #fff; padding: 8px 14px; border-radius: 8px; font: 14px Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  border-left: 3px solid #ffc83c; animation: hunt-in .2s ease-out; max-width: 260px; }
.hunt-count { position: fixed; inset: 0; z-index: 9100; display: none; align-items: center; justify-content: center; pointer-events: none;
  background: rgba(0,0,0,.35); color: #ffd764; font: bold 120px Arial, "PingFang SC", sans-serif; text-shadow: 0 4px 24px rgba(0,0,0,.8); }
.hunt-count.show { display: flex; }
.hunt-count.go { font-size: 72px; }
.hunt-flash { position: fixed; inset: 0; z-index: 9100; pointer-events: none; opacity: 0; transition: opacity .8s ease-out;
  background: radial-gradient(circle at center, rgba(255,215,100,.95), rgba(255,200,60,.55) 55%, rgba(255,200,60,.15)); }
.hunt-flash.on { opacity: 1; transition: opacity .05s; }
.hunt-board { position: fixed; inset: 0; z-index: 9100; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.7); }
.hunt-board.show { display: flex; }
.hunt-board .panel { width: min(440px, 92vw); max-height: 88vh; overflow: auto; box-sizing: border-box; padding: 20px;
  background: rgba(26,26,46,.97); border: 2px solid rgba(218,165,32,.5); border-radius: 14px; color: #fff;
  font: 15px/1.5 Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
.hunt-board h3 { margin: 0 0 4px; color: #DAA520; font-size: 22px; text-align: center; }
.hunt-board .sub { text-align: center; color: rgba(255,255,255,.8); margin-bottom: 12px; font-size: 15px; }
.hunt-board .row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; background: rgba(255,255,255,.05); margin-bottom: 5px; }
.hunt-board .row.me { outline: 1px solid #ffd764; }
.hunt-board .rk { flex: none; width: 28px; height: 28px; border-radius: 50%; text-align: center; line-height: 28px; font-weight: bold; background: rgba(255,255,255,.15); color: #fff; }
.hunt-board .row.r1 .rk { background: #ffc83c; color: #3a2a00; }
.hunt-board .row.r2 .rk { background: #c9ced6; color: #222; }
.hunt-board .row.r3 .rk { background: #cd8a4b; color: #2a1500; }
.hunt-board .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hunt-board .tm { flex: none; color: #ffd764; font-variant-numeric: tabular-nums; }
.hunt-board .tm.none { color: rgba(255,255,255,.45); }
.hunt-board .close { display: block; margin: 14px auto 0; min-height: 44px; min-width: 120px; border-radius: 10px; border: 0; background: #DAA520; color: #1a1a2e; font-size: 16px; font-weight: bold; cursor: pointer; }
.hunt-nick { margin: 4px 0 18px; padding: 14px 16px; border-radius: 10px; background: rgba(255,200,60,.09); border: 1px solid rgba(255,200,60,.35); text-align: left; }
.hunt-nick .rm { color: #ffd764; font-weight: bold; font-size: 16px; margin-bottom: 8px; }
.hunt-nick .rw { display: flex; gap: 8px; }
.hunt-nick input { flex: 1; min-width: 0; height: 40px; box-sizing: border-box; padding: 0 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.35);
  background: rgba(0,0,0,.35); color: #fff; font-size: 16px; }
.hunt-nick button { flex: none; height: 40px; min-width: 88px; padding: 0 14px; border-radius: 8px; border: 0; background: #DAA520; color: #1a1a2e; font-size: 15px; font-weight: bold; cursor: pointer; touch-action: manipulation; }
.hunt-nick button:disabled { opacity: .55; cursor: default; }
.hunt-nick .msg { min-height: 20px; margin-top: 6px; font-size: 14px; color: rgba(255,255,255,.8); }
.hunt-nick .msg.err { color: #ff9a9a; }
.hunt-gate { position: fixed; inset: 0; z-index: 9500; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.82); }
.hunt-gate.show { display: flex; }
.hunt-gate .hunt-nick { width: min(380px, 90vw); margin: 0; background: rgba(26,26,46,.97); }
.hunt-gate h2 { margin: 0 0 10px; color: #DAA520; font: bold 22px Arial, "PingFang SC", sans-serif; }
@keyframes hunt-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
@media (max-width: 900px) {
  .hunt-bar { top: 8px; width: calc(100vw - 340px); min-width: 200px; }
  .hunt-toast-box { top: 146px; right: 12px; }
  .hunt-count { font-size: 88px; }
  .hunt-count.go { font-size: 52px; }
}
@media (max-width: 768px) and (orientation: portrait) {
  .hunt-bar { top: 146px; width: calc(100vw - 24px); }
  .hunt-toast-box { top: 214px; }
}
`;

const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export class HuntHUD {
  constructor({ isMobile = false } = {}) {
    this.isMobile = isMobile;
    this.nodes = [];
    this.cache = {};
    this.boardFinal = false;
    this._flashTimer = 0;
    this._boardVisible = false;
    this._build();
  }

  _build() {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      document.head.appendChild(st);
      this.nodes.push(st);
    }
    // 顶部状态条
    this.bar = el('div', 'hunt-bar');
    const text = el('div', 'hunt-text');
    this.l1 = el('div', 'l1');
    this.l2 = el('div', 'l2');
    text.append(this.l1, this.l2);
    this.boardBtn = el('button', 'hunt-board-btn', '排行');
    this.boardBtn.type = 'button';
    this.boardBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleBoard(); });
    this.bar.append(text, this.boardBtn);
    // 倒数、闪光、toast、排行榜
    this.count = el('div', 'hunt-count');
    this.flash = el('div', 'hunt-flash');
    this.toastBox = el('div', 'hunt-toast-box');
    this.board = el('div', 'hunt-board');
    this.board.addEventListener('click', (e) => { if (e.target === this.board && !this.boardFinal) this.hideBoard(); });
    document.body.append(this.bar, this.count, this.flash, this.toastBox, this.board);
    this.nodes.push(this.bar, this.count, this.flash, this.toastBox, this.board);

    // Tab 键：按住显示排行榜（桌面）
    this._onKey = (e) => {
      if (e.code !== 'Tab') return;
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      e.preventDefault();
      if (e.type === 'keydown') { if (!e.repeat) this.onBoardRequest?.(); }
      else if (!this.boardFinal) this.hideBoard();
    };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    // 指针锁定后输入框必须失焦，否则 WASD 会被输入框吃掉
    this._onPL = () => { if (document.pointerLockElement) document.activeElement?.blur?.(); };
    document.addEventListener('pointerlockchange', this._onPL);
  }

  // ───────────── 进房：昵称 ─────────────

  /**
   * 桌面：把昵称框叠加进欢迎遮罩；手机：全屏首屏对话框。
   * onSubmit(nick) 由使用方校验并决定是否真正加入，返回错误文案或 null。
   * 返回 { getNick, setNick, setMessage, markJoined }。
   */
  mountNickEntry({ code, defaultNick, onSubmit }) {
    const box = el('div', 'hunt-nick');
    box.appendChild(el('div', 'rm', `金蛋房间 ${code}`));
    const rw = el('div', 'rw');
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 8;
    input.value = defaultNick;
    input.placeholder = '你的昵称（2~8 个字）';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', '昵称');
    // 输入框内的按键不要冒泡到游戏（M 开地图、空格跳、WASD 移动）
    for (const t of ['keydown', 'keyup', 'keypress']) input.addEventListener(t, (e) => e.stopPropagation());
    const btn = el('button', null, this.isMobile ? '进入' : '加入房间');
    btn.type = 'button';
    rw.append(input, btn);
    const msg = el('div', 'msg');
    box.append(rw, msg);

    // 点在昵称框里不要触发“点击屏幕锁定鼠标”，手机上也不要被当成拖动视角
    for (const t of ['click', 'touchstart', 'touchmove', 'touchend']) box.addEventListener(t, (e) => e.stopPropagation());

    const submit = () => {
      const err = onSubmit(input.value);
      if (err) { msg.className = 'msg err'; msg.textContent = err; }
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); submit(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

    let gate = null;
    if (this.isMobile) {
      gate = el('div', 'hunt-gate show');
      const card = box;
      const h = el('h2', null, '故宫金蛋');
      card.insertBefore(h, card.firstChild);
      gate.appendChild(card);
      document.body.appendChild(gate);
      this.nodes.push(gate);
    } else {
      const content = document.querySelector('#welcome-overlay .welcome-content');
      if (content) {
        const anchor = content.querySelector('p');
        content.insertBefore(box, anchor || content.children[1] || null);
        this.nodes.push(box);
      } else {
        // 没有欢迎遮罩时退化为全屏对话框
        gate = el('div', 'hunt-gate show');
        gate.appendChild(box);
        document.body.appendChild(gate);
        this.nodes.push(gate);
      }
    }
    return {
      getNick: () => input.value,
      setNick: (v) => { input.value = v; },
      setMessage: (t, isErr = false) => { msg.className = isErr ? 'msg err' : 'msg'; msg.textContent = t; },
      markJoined: (t) => {
        input.disabled = true; btn.disabled = true; btn.textContent = '已加入';
        msg.className = 'msg'; msg.textContent = t || '';
        if (gate) gate.classList.remove('show');
      },
      unlock: () => { input.disabled = false; btn.disabled = false; btn.textContent = this.isMobile ? '进入' : '加入房间'; },
    };
  }

  // ───────────── 顶部状态条 ─────────────

  setBar(line1, line2, { bad = false } = {}) {
    this.bar.classList.add('show');
    if (this.cache.l1 !== line1) { this.cache.l1 = line1; this.l1.textContent = line1; }
    if (this.cache.l2 !== line2) { this.cache.l2 = line2; this.l2.textContent = line2; }
    if (this.cache.bad !== bad) { this.cache.bad = bad; this.bar.classList.toggle('bad', bad); }
  }

  hideBar() { this.bar.classList.remove('show'); }

  /** 新提示出现：状态条闪动并展开 3 秒 */
  flashHint() {
    this.bar.classList.add('flash');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => this.bar.classList.remove('flash'), 3000);
  }

  // ───────────── 全屏倒数 / 闪光 / toast ─────────────

  /** text 为 null 则隐藏；'开始找！' 用小字号 */
  setCountdown(text) {
    if (this.cache.count === text) return;
    this.cache.count = text;
    if (text == null) { this.count.classList.remove('show', 'go'); return; }
    this.count.textContent = text;
    this.count.classList.add('show');
    this.count.classList.toggle('go', text.length > 1);
  }

  goldFlash() {
    this.flash.classList.add('on');
    // 下一帧撤掉 on，由 transition 做 0.8 s 的淡出
    requestAnimationFrame(() => requestAnimationFrame(() => this.flash.classList.remove('on')));
  }

  toast(text, ms = 2000) {
    const t = el('div', 'hunt-toast', text);
    this.toastBox.appendChild(t);
    while (this.toastBox.children.length > 4) this.toastBox.firstChild.remove();
    setTimeout(() => t.remove(), ms);
  }

  // ───────────── 排行榜 ─────────────

  /**
   * rows: [{rank, nick, ms|null, me}]；opts.final = 终局（不可点背景关闭，带“金蛋在”）
   */
  showBoard(rows, { final = false, eggHall = null, title = null } = {}) {
    this.boardFinal = final;
    this._boardVisible = true;
    this.board.textContent = '';
    const panel = el('div', 'panel');
    panel.appendChild(el('h3', null, title || (final ? '本局结束' : '排行榜')));
    if (final && eggHall) panel.appendChild(el('div', 'sub', `金蛋在：${eggHall}`));
    else panel.appendChild(el('div', 'sub', rows.some((r) => r.rank) ? '已经找到金蛋的人' : '还没有人找到'));
    for (const r of rows) {
      const row = el('div', `row${r.rank && r.rank <= 3 ? ` r${r.rank}` : ''}${r.me ? ' me' : ''}`);
      row.appendChild(el('div', 'rk', r.rank ? String(r.rank) : '-'));
      row.appendChild(el('div', 'nm', r.me ? `${r.nick}（我）` : r.nick));
      row.appendChild(el('div', `tm${r.rank ? '' : ' none'}`, r.rank ? fmtTime(r.ms) : '未找到'));
      panel.appendChild(row);
    }
    const close = el('button', 'close', final ? '继续游览' : '关闭');
    close.type = 'button';
    close.addEventListener('click', (e) => { e.stopPropagation(); this.hideBoard(true); });
    panel.appendChild(close);
    this.board.appendChild(panel);
    this.board.classList.add('show');
  }

  hideBoard() {
    this._boardVisible = false;
    this.boardFinal = false;
    this.board.classList.remove('show');
    this.onBoardClose?.();
  }

  get boardVisible() { return this._boardVisible; }

  toggleBoard() {
    if (this._boardVisible) this.hideBoard();
    else this.onBoardRequest?.();
  }

  // ───────────── 销毁 ─────────────

  dispose() {
    clearTimeout(this._flashTimer);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
    document.removeEventListener('pointerlockchange', this._onPL);
    for (const n of this.nodes) n.remove();
    this.nodes = [];
  }
}

export { fmtTime };
