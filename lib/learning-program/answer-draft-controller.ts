import type { CourseLessonGrade } from './types.ts';
export type DraftSnapshot = {
  answers: Record<string,string>; status: 'loading'|'saved'|'unsaved'|'saving'|'error'|'conflict';
  loaded: boolean; message: string; grade?:CourseLessonGrade|null;
};
/** One controller per course/question version; saves are serialized, never last-response-wins. */
export class AnswerDraftController {
  private snapshot: DraftSnapshot = {answers:{},status:'loading',loaded:false,message:'正在恢复答案草稿…'};
  private listeners = new Set<() => void>();
  private revision = 0;
  private fingerprint = '';
  private edits = 0;
  private savedEdits = 0;
  private loading?: Promise<void>;
  private saving?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private programId: string;
  private lessonId: string;
  private fetcher: typeof fetch;
  private expectedVersion: string;
  // A native Window.fetch stored as a method receives this controller as `this`.
  // Keep the browser receiver intact; Node's fetch does not expose this failure.
  constructor(programId: string, lessonId: string, expectedVersion = '', fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) { this.programId=programId;this.lessonId=lessonId;this.expectedVersion=expectedVersion;this.fetcher=fetcher; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener);return () => {this.listeners.delete(listener);}; };
  private update(change: Partial<DraftSnapshot>) { this.snapshot={...this.snapshot,...change};this.listeners.forEach(listener=>listener()); }
  isDirty = () => this.edits !== this.savedEdits;
  load = () => {
    if (this.snapshot.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async()=>{
      try {
        const response=await this.fetcher(`/api/learning-drafts?programId=${encodeURIComponent(this.programId)}&lessonId=${encodeURIComponent(this.lessonId)}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
        const data=await response.json();
        if (!response.ok) throw new Error(data.error || '草稿恢复失败');
        if(this.expectedVersion && data.questionVersion!==this.expectedVersion) throw new Error('课程题目已改变，请刷新课程后继续；未载入其他版本的草稿。');
        this.revision=data.revision;this.fingerprint=data.fingerprint;
        this.update({answers:data.answers,grade:data.grade,loaded:true,status:'saved',message:data.updatedAt?'已恢复上次保存的答案':data.grade?'已恢复上次提交的答案和评分':'答案将自动保存'});
      } catch(error) {this.update({status:'error',message:error instanceof Error?error.message:'草稿恢复失败'});}
      finally {this.loading=undefined;}
    })();
    return this.loading;
  };
  setAnswer = (id: string, value: string) => {
    if (!this.snapshot.loaded) return;
    this.edits++;
    const conflict=this.snapshot.status==='conflict';
    this.update({answers:{...this.snapshot.answers,[id]:value.slice(0,3000)},...(conflict?{}:{status:'unsaved',message:'答案尚未保存…'})});
    clearTimeout(this.timer);
    if (!conflict) this.timer=setTimeout(()=>void this.flush(),600);
  };
  flush = () => {
    clearTimeout(this.timer);
    if (this.saving) return this.saving;
    if (!this.snapshot.loaded || !this.isDirty() || this.snapshot.status==='conflict') return Promise.resolve();
    this.saving=(async()=>{
      while(this.isDirty()){
        const edit=this.edits, answers={...this.snapshot.answers};
        this.update({status:'saving',message:'正在保存答案…'});
        try {
          const response=await this.fetcher('/api/learning-drafts',{method:'PUT',headers:{'Content-Type':'application/json'},keepalive:true,signal:AbortSignal.timeout(15000),
            body:JSON.stringify({programId:this.programId,lessonId:this.lessonId,fingerprint:this.fingerprint,revision:this.revision,answers})});
          const data=await response.json();
          if (!response.ok) {this.update({status:response.status===409?'conflict':'error',message:data.error || '草稿未保存，请重试'});break;}
          this.revision=data.revision;this.savedEdits=edit;
          this.update({status:this.isDirty()?'unsaved':'saved',message:this.isDirty()?'正在保存后续修改…':'答案已保存，可刷新后继续'});
        }catch(error){this.update({status:'error',message:error instanceof Error?`草稿未保存：${error.message}`:'草稿未保存，请重试'});break;}
      }
    })().finally(()=>{this.saving=undefined;});
    return this.saving;
  };
}
