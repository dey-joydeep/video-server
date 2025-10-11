/* Lightweight seek buttons for Video.js v8 (no external deps).
 * Adds back/forward buttons to the control bar.
 */
(function () {
  const videojs = window.videojs;
  if (!videojs) return;

  const Button = videojs.getComponent('Button');

  class BackSeekButton extends Button {
    constructor(player, options) {
      super(player, options);
      this.back = (options && options.back) || 10;
      this.addClass('vjs-seek-button');
      this.addClass('vjs-seek-back');
      this.controlText(`Back ${this.back}s`);
      this.el().innerHTML = `<span class="vjs-icon">⟲ ${this.back}</span>`;
    }
    handleClick() {
      const p = this.player();
      const t = Math.max(0, (p.currentTime() || 0) - this.back);
      p.currentTime(t);
    }
  }

  class ForwardSeekButton extends Button {
    constructor(player, options) {
      super(player, options);
      this.forward = (options && options.forward) || 10;
      this.addClass('vjs-seek-button');
      this.addClass('vjs-seek-forward');
      this.controlText(`Forward ${this.forward}s`);
      this.el().innerHTML = `<span class="vjs-icon">${this.forward} ⟳</span>`;
    }
    handleClick() {
      const p = this.player();
      const dur = p.duration() || 0;
      const t = Math.min(dur, (p.currentTime() || 0) + this.forward);
      p.currentTime(t);
    }
  }

  videojs.registerComponent('BackSeekButton', BackSeekButton);
  videojs.registerComponent('ForwardSeekButton', ForwardSeekButton);

  videojs.registerPlugin('seekButtons', function (opts) {
    const options = opts || {};
    const controlBar = this.controlBar;
    if (!controlBar) return;

    const playToggle = controlBar.playToggle;
    const backBtn = this.addChild('BackSeekButton', {
      back: options.back || 10,
    });
    const fwdBtn = this.addChild('ForwardSeekButton', {
      forward: options.forward || 10,
    });

    if (playToggle && playToggle.el()) {
      controlBar.el().insertBefore(backBtn.el(), playToggle.el().nextSibling);
      controlBar.el().insertBefore(fwdBtn.el(), backBtn.el().nextSibling);
    } else {
      controlBar.el().appendChild(backBtn.el());
      controlBar.el().appendChild(fwdBtn.el());
    }
  });
})();
