from __future__ import annotations

from dataclasses import dataclass

from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from .models import EvidenceQueryPlan, GoalSnapshot, SkillSnapshot
from .settings import Settings


@dataclass(frozen=True)
class PlannerDependencies:
    goal: GoalSnapshot
    skills: list[SkillSnapshot]


def fallback_plan(dependencies: PlannerDependencies) -> EvidenceQueryPlan:
    concepts = [skill.name for skill in dependencies.skills[:6] if skill.name.strip()]
    if not concepts:
        concepts = [dependencies.goal.title]
    descriptions = [skill.description for skill in dependencies.skills[:4] if skill.description.strip()]
    query_parts = [dependencies.goal.title, *concepts, *descriptions]
    return EvidenceQueryPlan(
        query=" ".join(dict.fromkeys(part.strip() for part in query_parts if part.strip()))[:1000],
        required_concepts=concepts,
    )


async def build_evidence_query_plan(
    settings: Settings,
    dependencies: PlannerDependencies,
) -> tuple[EvidenceQueryPlan, str]:
    if not settings.llm_ready:
        return fallback_plan(dependencies), "rules"

    model = OpenAIChatModel(
        settings.llm_model,
        provider=OpenAIProvider(base_url=settings.llm_base_url, api_key=settings.llm_api_key),
    )
    agent = Agent(
        model,
        deps_type=PlannerDependencies,
        output_type=EvidenceQueryPlan,
        model_settings=settings.structured_model_settings,
        system_prompt=(
            "你是学习资料检索规划器。只根据给定目标和能力点生成一次简洁检索计划。"
            "query 要包含目标中特有名词和最重要能力；required_concepts 只列本轮课程必须覆盖的概念。"
            "不要回答目标，不要虚构资料内容，不要输出思考过程。"
        ),
    )

    @agent.instructions
    def context_prompt(ctx: RunContext[PlannerDependencies]) -> str:
        skills = "\n".join(f"- {skill.name}: {skill.description}" for skill in ctx.deps.skills)
        return (
            f"学习目标：{ctx.deps.goal.title}\n"
            f"目标说明：{ctx.deps.goal.description}\n"
            f"用户背景：{ctx.deps.goal.background}\n"
            f"能力地图：\n{skills}"
        )

    result = await agent.run("为目标资料库生成课程编排前的检索计划。", deps=dependencies)
    return result.output, "llm"
