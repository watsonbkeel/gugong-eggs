const { chromium } = require('playwright');
const assert = require('node:assert/strict');

// 在场感验收：镜头起伏、脚步节奏、碰撞无漂移、环境音效生命周期。
(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  const results = {};
  const checks = [];
  const check = (name, value) => { checks.push({ name, passed: !!value }); };
  try {
    const page = await (await browser.newContext({ viewport: { width: 960, height: 600 } })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.env.PALACE_URL || 'http://127.0.0.1:5173', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__forbiddenCityApp?.postProcessing?.composer && document.querySelector('#loading-screen').style.display === 'none', null, { timeout: 180000 });

    // headless + swiftshader 渲染极慢（约 1~2 fps，dt 被钳到 0.1），先暂停渲染循环，
    // 再以固定 60fps 时间步手动驱动 controls.update()，逐帧采样，结果与真实帧率无关。
    await page.evaluate(() => {
      const a = window.__forbiddenCityApp;
      cancelAnimationFrame(a.animationFrame);
      a._animate = () => {};
      window.__walk = (codes, seconds, releaseSeconds, fps = 60) => {
        const c = a.controls;
        c.controls.isLocked = true;
        const step = 1000 / fps;
        const frames = [];
        let released = false;
        for (const code of codes) c.onKeyDown({ code });
        const total = Math.round((seconds + releaseSeconds) * fps);
        const pressFrames = Math.round(seconds * fps);
        for (let i = 0; i < total; i++) {
          if (i === pressFrames) { released = true; for (const code of codes) c.onKeyUp({ code }); }
          c.prevTime = performance.now() - step;
          c.update();
          const m = c.motion;
          frames.push({ t: (i + 1) * step, dt: step / 1000, y: a.camera.position.y, x: a.camera.position.x, z: a.camera.position.z, speed: m.speed, footstep: m.footstep, sprint: m.sprint, released });
        }
        c.controls.isLocked = false;
        return frames;
      };
    });

    // 1) 开阔地直行 3 秒
    const walk = await page.evaluate(async () => {
      const a = window.__forbiddenCityApp;
      a.controls.setPosition(0, 1.7, -205);
      a.controls.lookAt(0, -150);
      const frames = window.__walk(['KeyW'], 3, 1);
      const moving = frames.filter(f => !f.released);
      const after = frames.filter(f => f.released);
      const simTime = moving.reduce((s, f) => s + f.dt, 0);
      const steady = moving.filter(f => f.t > 600);
      const ys = moving.map(f => f.y);
      const lastY = after[after.length - 1].y;
      return {
        frames: frames.length,
        movingFrames: moving.length,
        simTime: +simTime.toFixed(3),
        yMin: +Math.min(...ys).toFixed(4),
        yMax: +Math.max(...ys).toFixed(4),
        footsteps: moving.filter(f => f.footstep).length,
        expectedFootsteps: +(simTime * 1.8).toFixed(1),
        speedMean: +(steady.reduce((s, f) => s + f.speed, 0) / Math.max(steady.length, 1)).toFixed(3),
        yAfterRelease: +lastY.toFixed(5),
        speedAfterRelease: after[after.length - 1].speed,
        footstepAfterRelease: after.slice(-3).some(f => f.footstep),
        motion: a.controls.motion,
      };
    });
    results.walk = walk;
    check('行走时相机有上下起伏（振幅 >0.02）', walk.yMax - walk.yMin > 0.04 && walk.yMax - walk.yMin < 0.08);
    check('脚步次数与步频一致', walk.footsteps >= Math.floor(walk.expectedFootsteps) - 1 && walk.footsteps <= Math.ceil(walk.expectedFootsteps) + 1 && walk.footsteps >= 2);
    check('稳定速度约 5 米/秒', Math.abs(walk.speedMean - 5) < 0.6);
    check('松开后高度回到 1.7±0.002', Math.abs(walk.yAfterRelease - 1.7) <= 0.002);
    check('静止时 speed=0 且无脚步', walk.speedAfterRelease === 0 && !walk.footstepAfterRelease);

    // 2) 走向午门侧墙 (15, -150)：停在墙前，y 不漂移
    const wall = await page.evaluate(async () => {
      const a = window.__forbiddenCityApp;
      a.controls.setPosition(15, 1.7, -172);
      a.controls.lookAt(15, -150);
      const frames = window.__walk(['KeyW'], 5, 1);
      const pressing = frames.filter(f => !f.released);
      const tail = pressing.slice(-Math.max(3, Math.floor(pressing.length / 4)));
      const last = frames[frames.length - 1];
      return {
        finalX: +last.x.toFixed(4), finalZ: +last.z.toFixed(4), finalY: +last.y.toFixed(5),
        insideWall: a.collisionManager.checkCollision(a.camera.position.clone().setY(1.7), 0.5),
        blockedSpeedMean: +(tail.reduce((s, f) => s + f.speed, 0) / tail.length).toFixed(3),
        blockedFootsteps: tail.filter(f => f.footstep).length,
        yRangeWhileBlocked: +(Math.max(...tail.map(f => f.y)) - Math.min(...tail.map(f => f.y))).toFixed(4),
      };
    });
    results.wall = wall;
    check('走向午门侧墙被挡住', wall.finalZ < -160 && !wall.insideWall);
    check('撞墙后 x 不漂移', Math.abs(wall.finalX - 15) < 0.05);
    check('撞墙后 y 无累积漂移', Math.abs(wall.finalY - 1.7) <= 0.002);
    check('顶墙时实际速度约 0 不再计步', wall.blockedSpeedMean < 0.3 && wall.blockedFootsteps === 0);

    // 3) setHeadBob 开关 / setPosition 清零
    const toggle = await page.evaluate(async () => {
      const a = window.__forbiddenCityApp;
      const c = a.controls;
      c.setPosition(0, 1.7, -205);
      c.lookAt(0, -150);
      const step = n => { for (let i = 0; i < n; i++) { c.prevTime = performance.now() - 1000 / 60; c.update(); } };
      c.controls.isLocked = true;
      c.onKeyDown({ code: 'KeyW' });
      step(75);
      const yBobbing = a.camera.position.y;
      c.setHeadBob(false);
      const yOff = a.camera.position.y;
      step(30);
      const yStillOff = a.camera.position.y;
      const footstepsWhileOff = (() => { let n = 0; for (let i = 0; i < 60; i++) { step(1); if (c.motion.footstep) n++; } return n; })();
      c.setHeadBob(true);
      c.onKeyUp({ code: 'KeyW' });
      c.setPosition(3, 1.7, -200);
      const afterSet = { y: a.camera.position.y, bob: c.bobOffset.length() };
      c.controls.isLocked = false;
      return { yBobbing, yOff, yStillOff, footstepsWhileOff, afterSet };
    });
    results.toggle = toggle;
    check('关闭起伏后立即无偏移（脚步事件仍输出）', toggle.yBobbing !== 1.7 && toggle.yOff === 1.7 && toggle.yStillOff === 1.7 && toggle.footstepsWhileOff >= 1);
    check('setPosition 清零起伏偏移', toggle.afterSet.y === 1.7 && toggle.afterSet.bob === 0);

    // 4) 环境音效
    const audio = await page.evaluate(async () => {
      const a = window.__forbiddenCityApp;
      const amb = a.ambience;
      const out = { beforeStart: amb.ctx === null };
      amb.update({ dt: 0.016, speed: 5, footstep: true, inTunnel: true, sprint: false });
      amb.start();
      amb.start();
      await new Promise(r => setTimeout(r, 300));
      out.state = amb.ctx.state;
      out.currentTime0 = amb.ctx.currentTime;
      const ctx = amb.ctx;
      // 门洞：手动推进 update，检查湿声比例与风声低通
      for (let i = 0; i < 120; i++) amb.update({ dt: 1 / 60, speed: 5, footstep: i % 20 === 0, inTunnel: true, sprint: i > 60 });
      await new Promise(r => setTimeout(r, 1500));
      out.currentTime1 = amb.ctx.currentTime;
      out.tunnel = { mix: amb.tunnelMix, envSend: +amb.envSend.gain.value.toFixed(3), stepSendTarget: amb.tunnelTarget * 0.9, windLowpass: Math.round(amb.wind.lowpass.frequency.value) };
      for (let i = 0; i < 240; i++) amb.update({ dt: 1 / 60, speed: 0, footstep: false, inTunnel: false });
      await new Promise(r => setTimeout(r, 1500));
      out.outside = { mix: amb.tunnelMix, envSend: +amb.envSend.gain.value.toFixed(3), stepSendTarget: amb.tunnelTarget * 0.9, windLowpass: Math.round(amb.wind.lowpass.frequency.value) };
      amb.playBird(); amb.playChime();
      amb.setMuted(true);
      await new Promise(r => setTimeout(r, 600));
      out.mutedGain = +amb.master.gain.value.toFixed(4);
      out.isMuted = amb.isMuted();
      amb.setMuted(false);
      await new Promise(r => setTimeout(r, 600));
      out.unmutedGain = +amb.master.gain.value.toFixed(4);
      // 页面隐藏 / 可见
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r => setTimeout(r, 200));
      out.hiddenState = ctx.state;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r => setTimeout(r, 200));
      out.visibleState = ctx.state;
      delete document.hidden;
      out.timersBeforeDispose = amb.timers.size;
      amb.dispose();
      await new Promise(r => setTimeout(r, 300));
      out.disposedState = ctx.state;
      out.timersAfterDispose = amb.timers.size;
      amb.update({ dt: 0.016, speed: 5, footstep: true, inTunnel: false });
      amb.setMuted(true);
      return out;
    });
    results.audio = audio;
    check('未 start 前 update 不报错', audio.beforeStart);
    check('start 后 AudioContext running', audio.state === 'running');
    check('门洞内混响湿声升高、风声变闷', audio.tunnel.mix > 0.9 && audio.tunnel.envSend > 0.4 && audio.tunnel.stepSendTarget === 0.9 && audio.tunnel.windLowpass < 800);
    check('离开门洞平滑恢复', audio.outside.mix === 0 && audio.outside.envSend < 0.05 && audio.outside.stepSendTarget === 0 && audio.outside.windLowpass > 2000);
    check('静音淡出 / 取消静音淡入', audio.mutedGain < 0.01 && audio.isMuted && Math.abs(audio.unmutedGain - 0.6) < 0.01);
    check('页面隐藏暂停、可见恢复', audio.hiddenState === 'suspended' && audio.visibleState === 'running');
    check('dispose 后 AudioContext closed、定时器清空', audio.disposedState === 'closed' && audio.timersAfterDispose === 0 && audio.timersBeforeDispose > 0);

    check('浏览器无未捕获 JavaScript 错误', errors.length === 0);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ results, checks, errors }, null, 2));
  const failed = checks.filter(c => !c.passed);
  assert.equal(failed.length, 0, `失败项：${failed.map(c => c.name).join('、')}`);
  console.log(`SENSE OK ${checks.length}/${checks.length}`);
})().catch(error => { console.error(error.message || error); process.exitCode = 1; });
