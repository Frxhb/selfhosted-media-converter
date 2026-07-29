"""Kanal-Abonnement-Routen: CRUD für Subscriptions sowie manuelles Auslösen einer Prüfung."""
from fastapi import APIRouter, HTTPException

from app.models import Subscription, SubscriptionCreateRequest
from app import subscription_manager as sub_module

router = APIRouter()


def _get_manager():
    if sub_module.subscription_manager is None:
        raise HTTPException(status_code=503, detail="Subscription-Manager ist noch nicht bereit (Server startet gerade).")
    return sub_module.subscription_manager


@router.get("/api/subscriptions", response_model=list[Subscription])
def get_subscriptions():
    return _get_manager().get_all()


@router.post("/api/subscriptions", response_model=Subscription)
def create_subscription(request: SubscriptionCreateRequest):
    if not request.url.strip():
        raise HTTPException(status_code=400, detail="Bitte eine Kanal- oder Playlist-URL angeben.")
    if not request.name.strip():
        raise HTTPException(status_code=400, detail="Bitte einen Namen für das Abonnement angeben.")
    return _get_manager().create(request)


@router.put("/api/subscriptions/{sub_id}", response_model=Subscription)
def update_subscription(sub_id: str, request: SubscriptionCreateRequest):
    updated = _get_manager().update(sub_id, request)
    if not updated:
        raise HTTPException(status_code=404, detail="Abonnement nicht gefunden.")
    return updated


@router.delete("/api/subscriptions/{sub_id}")
def delete_subscription(sub_id: str):
    if not _get_manager().delete(sub_id):
        raise HTTPException(status_code=404, detail="Abonnement nicht gefunden.")
    return {"status": "deleted"}


@router.post("/api/subscriptions/{sub_id}/check-now")
async def check_subscription_now(sub_id: str):
    manager = _get_manager()
    if not manager.get(sub_id):
        raise HTTPException(status_code=404, detail="Abonnement nicht gefunden.")
    return await manager.check_now(sub_id)
