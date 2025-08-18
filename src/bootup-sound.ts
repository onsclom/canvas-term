import bootupWav from './bootup.wav';

const audioCtx = new AudioContext();

// const masterGain = audioCtx.createGain();
// masterGain.gain.value = 1;
// masterGain.connect(audioCtx.destination);

// function noteToHz(noteNum: number) {
//   // Convert MIDI note number to frequency in Hz
//   return 440 * Math.pow(2, (noteNum - 69) / 12);
// }

// function noteNameToNoteNum(noteName: string) {
//   // Convert note name (e.g., "C4", "A#3") to
//   // MIDI note number
//   const noteMap: { [key: string]: number } = {
//     'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11,
//     'Db': 1, 'Eb': 3, 'Gb': 6, 'Ab': 8, 'Bb': 10 // Enharmonic equivalents
//   };
//   const match = noteName.match(/^([A-G][#b]?)(\d)$/);
//   if (!match) {
//     throw new Error(`Invalid note name: ${noteName}`);
//   }
//   const note = match[1];
//   const octave = parseInt(match[2], 10);
//   return noteMap[note] + (octave + 1) * 12;
// }

// export function playBootupSound() {
//   const oscillator = audioCtx.createOscillator();
//   // play arpegiated notes C F Bb D
//   const notes = ['C4', 'F4', 'Bb4', 'D5'];
//   const noteDuration = .15
//   let currentTime = audioCtx.currentTime;
//   for (let i = 0; i < notes.length; i++) {
//     const noteNum = noteNameToNoteNum(notes[i]);
//     oscillator.frequency.setValueAtTime(noteToHz(noteNum), currentTime);
//     currentTime += noteDuration
//   }
//   oscillator.type = 'triangle'
//   // oscillator.connect(masterGain);
//   oscillator.start(audioCtx.currentTime);
//   oscillator.stop(currentTime);
//   oscillator.connect(audioCtx.destination);
//   oscillator.onended = () => {
//     oscillator.disconnect();
//   };
// }

const bootupAudio = await fetch(bootupWav)
const bootupArrayBuffer = await bootupAudio.arrayBuffer();
const audioBuffer = await audioCtx.decodeAudioData(bootupArrayBuffer);

export function playBootupSound() {
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioCtx.destination);
  source.start(0);
  source.onended = () => {
    source.disconnect();
  }
}
