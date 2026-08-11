import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionHook = {
  isSupported: boolean;
  isListening: boolean;
  start: () => void;
  stop: () => void;
};

// Minimal local shapes for the Web Speech API. Declared standalone (not via
// `declare global` / InstanceType<typeof window.SpeechRecognition>) so they
// neither circularly reference themselves nor clash with the lib.dom
// SpeechRecognition types, which vary across TS versions.
type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultItemLike = {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
};
type SpeechRecognitionResultLike = {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultItemLike;
  };
};

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionClass(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function useSpeechRecognition(
  onFinalTranscript: (text: string) => void,
): SpeechRecognitionHook {
  const SRClass = getSpeechRecognitionClass();
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const [isListening, setIsListening] = useState(false);
  const callbackRef = useRef(onFinalTranscript);
  callbackRef.current = onFinalTranscript;

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  const start = useCallback(() => {
    if (!SRClass || isListening) return;

    const recognition = new SRClass();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event: SpeechRecognitionResultLike) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          transcript += result[0].transcript;
        }
      }
      if (transcript) {
        callbackRef.current(transcript);
      }
    };

    recognition.onerror = (event: Event & { error?: string }) => {
      // 'no-speech' and 'aborted' are normal — user paused or we called stop().
      const err = event.error;
      if (err !== 'no-speech' && err !== 'aborted') {
        console.warn('SpeechRecognition error:', err);
      }
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [SRClass, isListening]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);

  return {
    isSupported: SRClass !== null,
    isListening,
    start,
    stop,
  };
}
