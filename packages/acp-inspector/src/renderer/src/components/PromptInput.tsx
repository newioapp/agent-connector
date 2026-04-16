/**
 * PromptInput — text area to send prompts to the active session.
 */
import { useState, useRef } from 'react';
import { Send, StopCircle } from 'lucide-react';
import { useInspectorStore } from '../stores/inspector-store';
import { Button } from './ui';

export function PromptInput(): React.JSX.Element {
  const activeSessionId = useInspectorStore((s) => s.activeSessionId);
  const prompting = useInspectorStore((s) => s.prompting);
  const sendPrompt = useInspectorStore((s) => s.sendPrompt);
  const cancelPrompt = useInspectorStore((s) => s.cancelPrompt);
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = activeSessionId !== null && text.trim().length > 0;

  function handleSend(): void {
    if (!canSend) {
      return;
    }
    void sendPrompt(text.trim());
    setText('');
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t border-border px-4 py-3">
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            activeSessionId ? 'Type a prompt… (Enter to send, Shift+Enter for newline)' : 'Create a session first'
          }
          disabled={!activeSessionId}
        />
        <div className="flex flex-col gap-1">
          <Button variant="primary" onClick={handleSend} disabled={!canSend}>
            <Send size={12} />
            Send
          </Button>
          {prompting && (
            <Button variant="danger" onClick={() => void cancelPrompt()}>
              <StopCircle size={12} />
              Interrupt
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
