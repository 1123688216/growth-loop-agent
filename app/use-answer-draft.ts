"use client";
import {useEffect,useMemo,useSyncExternalStore} from 'react';
import {AnswerDraftController,type DraftSnapshot} from '@/lib/learning-program/answer-draft-controller';
const empty: DraftSnapshot={answers:{},status:'loading',loaded:false,message:'正在恢复答案草稿…'};
const emptySnapshot=()=>empty;
const noSubscribe=()=>()=>{};
export function useAnswerDraft(programId: string, lessonId: string, questionVersion: string) {
  const controller=useMemo(()=>programId&&lessonId&&questionVersion?new AnswerDraftController(programId,lessonId,questionVersion):null,[programId,lessonId,questionVersion]);
  const state=useSyncExternalStore(controller?.subscribe || noSubscribe,controller?.getSnapshot || emptySnapshot,emptySnapshot);
  useEffect(()=>{
    if(!controller)return;
    void controller.load();
    const warn=(event:BeforeUnloadEvent)=>{if(controller.isDirty()){void controller.flush();event.preventDefault();event.returnValue='';}};
    const flush=()=>{if(document.visibilityState==='hidden')void controller.flush();};
    window.addEventListener('beforeunload',warn);document.addEventListener('visibilitychange',flush);
    return ()=>{window.removeEventListener('beforeunload',warn);document.removeEventListener('visibilitychange',flush);void controller.flush();};
  },[controller]);
  return {...state,setAnswer:controller?.setAnswer || (()=>{}),flush:controller?.flush || (()=>Promise.resolve()),isDirty:controller?.isDirty || (()=>false),retry:()=>state.loaded?controller?.flush():controller?.load()};
}
