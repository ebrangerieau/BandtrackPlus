class AudioPlayer {
  constructor() {
    this.audio = new Audio();
    this.playlist = [];
    this.currentIndex = -1;
    this._createUI();
  }

  _createUI() {
    this.container = document.createElement('div');
    this.container.id = 'audio-player-controls';
    this.container.className = 'fixed bottom-0 left-0 right-0 bg-gray-100 flex items-center gap-2 p-2 shadow';

    this.playBtn = document.createElement('button');
    this.playBtn.className = 'btn-primary';
    this.playBtn.textContent = 'Play';
    this.playBtn.onclick = () => this.toggle();
    this.container.appendChild(this.playBtn);

    this.progress = document.createElement('input');
    this.progress.type = 'range';
    this.progress.min = 0;
    this.progress.max = 100;
    this.progress.value = 0;
    this.progress.className = 'flex-grow';
    this.progress.oninput = () => {
      const pct = this.progress.value / 100;
      this.audio.currentTime = pct * (this.audio.duration || 0);
    };
    this.container.appendChild(this.progress);

    this.volume = document.createElement('input');
    this.volume.type = 'range';
    this.volume.min = 0;
    this.volume.max = 1;
    this.volume.step = 0.01;
    this.volume.value = this.audio.volume;
    this.volume.oninput = () => {
      this.audio.volume = this.volume.value;
    };
    this.container.appendChild(this.volume);

    document.body.appendChild(this.container);

    this.audio.addEventListener('timeupdate', () => {
      if (this.audio.duration) {
        this.progress.value = (this.audio.currentTime / this.audio.duration) * 100;
      }
    });
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('play', () => {
      this.playBtn.textContent = 'Pause';
    });
    this.audio.addEventListener('pause', () => {
      this.playBtn.textContent = 'Play';
    });
  }

  play(src) {
    const idx = this.playlist.indexOf(src);
    if (idx === -1) {
      this.playlist.push(src);
      this.currentIndex = this.playlist.length - 1;
    } else {
      this.currentIndex = idx;
    }
    this.audio.src = src;
    return this.audio.play();
  }

  queue(src) {
    this.playlist.push(src);
  }

  next() {
    if (!this.playlist.length) return;
    this.currentIndex = (this.currentIndex + 1) % this.playlist.length;
    const src = this.playlist[this.currentIndex];
    this.audio.src = src;
    this.audio.play();
  }

  toggle() {
    if (this.audio.paused) {
      this.audio.play();
    } else {
      this.audio.pause();
    }
  }
}

export const audioPlayer = new AudioPlayer();
