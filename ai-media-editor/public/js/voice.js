// Push-to-talk speech input using the browser's built-in speech recognition.
// Hold the mic button (or the Space key when not typing) and release to send.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export function createVoiceInput({ button, input, getLang, onFinal }) {
  if (!Recognition) {
    button.disabled = true;
    return { supported: false };
  }
  let rec = null;
  let transcript = '';

  function start() {
    if (rec) return;
    transcript = '';
    rec = new Recognition();
    rec.lang = getLang();
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      let finalText = '';
      let interim = '';
      for (const result of e.results) {
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      transcript = finalText;
      input.value = `${finalText}${interim}`;
    };
    rec.onerror = () => stop();
    rec.onend = () => {
      button.classList.remove('listening');
      const text = (transcript || input.value).trim();
      rec = null;
      if (text) onFinal(text);
    };
    button.classList.add('listening');
    rec.start();
  }

  function stop() {
    if (rec) rec.stop();
  }

  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    start();
  });
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointerleave', stop);

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || document.activeElement === input) return;
    e.preventDefault();
    start();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && document.activeElement !== input) stop();
  });

  return { supported: true };
}

export function speak(text, lang) {
  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}
