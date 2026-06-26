export function createCallService({ elements, state, statusUI, getPeerApi, getSignalApi }) {
  const { log } = statusUI;

  function startCall() {
    return startLocalMedia();
  }

  async function startLocalMedia() {
    const pc = getPeerApi().getConnection();
    if (!pc || pc.connectionState === 'closed') {
      setCallState('idle', '未开始通话', '请先等待 P2P 连接成功，再开启通话。');
      log('请先建立 P2P 连接后再开启通话');
      updateCallButtons();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCallState('error', '当前浏览器不支持音视频通话', '请使用支持摄像头和麦克风权限的现代浏览器。');
      updateCallButtons();
      return;
    }

    if (state.localStream) {
      setCallState(state.hasRemoteMedia ? 'in-call' : 'calling', state.hasRemoteMedia ? '通话中' : '本地预览已开启', state.hasRemoteMedia ? '已与对端建立音视频通话。' : '等待对端开启音视频。');
      updateCallButtons();
      return;
    }

    setCallState('requesting-media', '正在申请摄像头和麦克风权限', '请在浏览器权限弹窗中选择允许。');
    updateCallButtons();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      state.localStream = stream;
      state.localAudioTrack = stream.getAudioTracks()[0] || null;
      state.localVideoTrack = stream.getVideoTracks()[0] || null;
      state.isMuted = false;
      state.isCameraOff = false;
      state.hasLocalMedia = true;
      bindVideo(elements.localVideo, stream, elements.localVideoPlaceholder);
      const addedTrackCount = attachLocalTracks(pc, stream);
      if (addedTrackCount > 0) {
        getSignalApi().requestNegotiation('start-call');
      }
      setCallState(state.hasRemoteMedia ? 'in-call' : 'calling', state.hasRemoteMedia ? '通话中' : '本地预览已开启', state.hasRemoteMedia ? '已与对端建立音视频通话。' : '等待对端开启音视频。');
      updateCallButtons();
      log('已开启本地音视频');
    } catch (error) {
      cleanupLocalMedia();
      setCallState('error', '摄像头或麦克风不可用', `请检查权限后重试：${error.message}`);
      updateCallButtons();
      log(`开启音视频失败：${error.message}`);
    }
  }

  function attachLocalTracks(pc, stream) {
    const existingTracks = new Set(state.mediaSenders.map((sender) => sender.track).filter(Boolean));
    let addedTrackCount = 0;
    for (const track of stream.getTracks()) {
      if (existingTracks.has(track)) continue;
      state.mediaSenders.push(pc.addTrack(track, stream));
      addedTrackCount += 1;
    }
    return addedTrackCount;
  }

  function handleRemoteTrack(event) {
    if (!state.remoteStream) {
      state.remoteStream = new MediaStream();
    }

    const tracks = event.streams[0]?.getTracks().length ? event.streams[0].getTracks() : [event.track];
    for (const track of tracks) {
      if (!state.remoteStream.getTracks().includes(track)) {
        state.remoteStream.addTrack(track);
      }
      track.addEventListener('ended', updateRemoteMediaState, { once: true });
      track.addEventListener('mute', updateRemoteMediaState);
      track.addEventListener('unmute', updateRemoteMediaState);
      log(`[诊断] 收到远端 ${track.kind} track：readyState=${track.readyState}, muted=${track.muted}`);
    }

    updateRemoteMediaState();
  }

  function updateRemoteMediaState() {
    state.hasRemoteMedia = Boolean(state.remoteStream?.getTracks().some((track) => track.readyState === 'live'));
    if (state.hasRemoteMedia) {
      bindVideo(elements.remoteVideo, state.remoteStream, elements.remoteVideoPlaceholder);
      setCallState('in-call', '通话中', state.hasLocalMedia ? '已与对端建立音视频通话。' : '正在接收对端音视频，你也可以开启本地音视频。');
    } else {
      clearVideo(elements.remoteVideo, elements.remoteVideoPlaceholder);
      if (!state.hasLocalMedia) {
        setCallState('idle', '未开始通话', '请先等待 P2P 连接成功，再开启通话。');
      }
    }
    updateCallButtons();
  }

  function toggleMic() {
    if (!state.localAudioTrack) return;
    state.isMuted = !state.isMuted;
    state.localAudioTrack.enabled = !state.isMuted;
    updateCallButtons();
    log(state.isMuted ? '已静音麦克风' : '已取消静音');
  }

  function toggleCamera() {
    if (!state.localVideoTrack) return;
    state.isCameraOff = !state.isCameraOff;
    state.localVideoTrack.enabled = !state.isCameraOff;
    updateCallButtons();
    log(state.isCameraOff ? '已关闭摄像头' : '已打开摄像头');
  }

  function hangupCall(options = {}) {
    const { notify = true, renegotiate = true } = options;
    const hadMedia = state.hasLocalMedia || state.hasRemoteMedia || state.mediaSenders.length > 0;
    cleanupMedia();
    setCallState('idle', notify ? '已挂断通话' : '对端已挂断', '文件传输连接仍可继续使用。');
    updateCallButtons();

    if (!hadMedia) return;

    if (notify && state.remotePeerId) {
      getSignalApi().sendSignal({ type: 'ready', to: state.remotePeerId, scope: 'call', action: 'hangup' });
    }

    if (renegotiate) {
      getSignalApi().requestNegotiation('hangup');
    }
  }

  function handleCallControl(message) {
    if (message.action !== 'hangup') return;
    hangupCall({ notify: false, renegotiate: true });
    log('对端已挂断通话');
  }

  function cleanupMedia({ removeSenders = true } = {}) {
    if (removeSenders) {
      removeMediaSenders();
    } else {
      state.mediaSenders = [];
    }
    cleanupLocalMedia();
    clearRemoteMedia();
    setCallState('idle', '未开始通话', '请先等待 P2P 连接成功，再开启通话。');
    updateCallButtons();
  }

  function removeMediaSenders() {
    const pc = getPeerApi().getConnection();
    if (pc && pc.signalingState !== 'closed') {
      for (const sender of state.mediaSenders) {
        try {
          pc.removeTrack(sender);
        } catch {}
      }
    }
    state.mediaSenders = [];
  }

  function cleanupLocalMedia() {
    state.localStream?.getTracks().forEach((track) => track.stop());
    state.localStream = null;
    state.localAudioTrack = null;
    state.localVideoTrack = null;
    state.isMuted = false;
    state.isCameraOff = false;
    state.hasLocalMedia = false;
    clearVideo(elements.localVideo, elements.localVideoPlaceholder);
  }

  function clearRemoteMedia() {
    state.remoteStream?.getTracks().forEach((track) => state.remoteStream.removeTrack(track));
    state.remoteStream = null;
    state.hasRemoteMedia = false;
    clearVideo(elements.remoteVideo, elements.remoteVideoPlaceholder);
  }

  function bindVideo(video, stream, placeholder) {
    video.srcObject = stream;
    video.closest('.video-tile')?.classList.add('has-video');
    placeholder.textContent = placeholder === elements.localVideoPlaceholder ? '本地预览' : '等待对端视频';
    video.play?.().catch(() => {});
  }

  function clearVideo(video, placeholder) {
    video.srcObject = null;
    video.closest('.video-tile')?.classList.remove('has-video');
    placeholder.textContent = placeholder === elements.localVideoPlaceholder ? '本地预览' : '等待对端视频';
  }

  function setCallState(status, text, hint) {
    state.callStatus = status;
    elements.callStatus.textContent = text;
    elements.callHint.textContent = hint;
  }

  function updateCallButtons() {
    const pc = getPeerApi()?.getConnection?.();
    const canStart = Boolean(pc && pc.connectionState !== 'closed' && state.remotePeerId);
    const requesting = state.callStatus === 'requesting-media';
    const hasAnyMedia = state.hasLocalMedia || state.hasRemoteMedia;

    elements.startCallBtn.disabled = !canStart || requesting || state.hasLocalMedia;
    elements.startCallBtn.textContent = requesting ? '申请权限中...' : state.hasLocalMedia ? '通话中' : '开始通话';
    elements.toggleMicBtn.disabled = !state.localAudioTrack;
    elements.toggleMicBtn.textContent = state.isMuted ? '取消静音' : '静音';
    elements.toggleCameraBtn.disabled = !state.localVideoTrack;
    elements.toggleCameraBtn.textContent = state.isCameraOff ? '打开摄像头' : '关闭摄像头';
    elements.hangupCallBtn.disabled = !hasAnyMedia && state.mediaSenders.length === 0;
  }

  updateCallButtons();

  return {
    startCall,
    toggleMic,
    toggleCamera,
    hangupCall,
    handleRemoteTrack,
    handleCallControl,
    cleanupMedia,
    updateCallButtons,
  };
}
