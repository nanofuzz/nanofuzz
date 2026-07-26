"""Framework-oriented fixture for external Python import analysis.

This file is not a real backend. It gives PythonProgram realistic FastAPI,
Pydantic, and PyTorch import forms without requiring those packages to be
installed merely to parse source code.
"""

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field
import torch
import torch.nn.functional as torch_functional


app = FastAPI()


class PredictionRequest(BaseModel):
    """A deliberately small request model for decorator/type-reference tests."""

    features: list[float] = Field(min_length=1)


def get_model_name() -> str:
    """Example FastAPI dependency with a primitive return type."""
    return "fixture-model"


def torch_probability_sum(features: list[float]) -> float:
    """Use an imported PyTorch namespace while keeping a fuzzable signature."""
    if not features:
        raise ValueError("features must not be empty")
    tensor = torch.tensor(features, dtype=torch.float32)
    probabilities = torch_functional.softmax(tensor, dim=0)
    return float(probabilities.sum().item())


@app.post("/predict")
def create_prediction(
    payload: PredictionRequest,
    model_name: str = Depends(get_model_name),
) -> float:
    """FastAPI endpoint: model class references remain safely unresolved."""
    score = torch_probability_sum(payload.features)
    if score <= 0:
        raise HTTPException(status_code=500, detail=f"invalid score from {model_name}")
    return score
