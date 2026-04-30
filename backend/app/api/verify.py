from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db.session import get_db
from app.models.schemas import VerifyRequest, VerifyResponse
from app.pipeline.verify import verify_claims

router = APIRouter()


@router.post("/verify", response_model=VerifyResponse)
async def verify(
    payload: VerifyRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> VerifyResponse:
    results = await verify_claims(db, payload.claims, settings)
    return VerifyResponse(results=results)
