"""Minimal FastAPI application providing authentication and role
management endpoints.  The implementation focuses on clarity over
completeness: tokens are stored in memory and should be replaced by a
persistent solution in production."""

from typing import Optional
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy.orm import Session
import uuid
import pyotp
from passlib.context import CryptContext

from . import models
from .database import Base, engine, SessionLocal

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

app = FastAPI()

# In-memory token store: refresh_token -> user_id
refresh_tokens: dict[str, int] = {}


class Token(BaseModel):
    access_token: str
    refresh_token: str


class UserCreate(BaseModel):
    username: str
    password: str
    email: Optional[str] = None


class RoleCreate(BaseModel):
    name: str
    description: Optional[str] = None


class TwoFAResponse(BaseModel):
    secret: str


# Dependency -------------------------------------------------------------

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Authentication helpers -------------------------------------------------

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


# Startup: create tables
Base.metadata.create_all(bind=engine)


@app.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
def register(user: UserCreate, db: Session = Depends(get_db)):
    if db.query(models.User).filter_by(username=user.username).first():
        raise HTTPException(status_code=400, detail="Username already exists")
    db_user = models.User(
        username=user.username,
        email=user.email,
        password_hash=hash_password(user.password),
    )
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return _issue_tokens(db_user.id)


@app.post("/login", response_model=Token)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db), otp: Optional[str] = None):
    user = db.query(models.User).filter_by(username=form.username).first()
    if not user or not verify_password(form.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if user.twofa_secret:
        if otp is None or not pyotp.TOTP(user.twofa_secret).verify(otp):
            raise HTTPException(status_code=401, detail="2FA code required")
    return _issue_tokens(user.id)


@app.post("/logout")
def logout(token: Token):
    refresh_tokens.pop(token.refresh_token, None)
    return {"detail": "Logged out"}


@app.post("/refresh", response_model=Token)
def refresh(token: Token):
    user_id = refresh_tokens.get(token.refresh_token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    return _issue_tokens(user_id)


def _issue_tokens(user_id: int) -> Token:
    access = uuid.uuid4().hex
    refresh = uuid.uuid4().hex
    refresh_tokens[refresh] = user_id
    return Token(access_token=access, refresh_token=refresh)


# 2FA endpoints ----------------------------------------------------------
@app.post("/2fa/setup", response_model=TwoFAResponse)
def setup_2fa(db: Session = Depends(get_db), user_id: int = 0):
    secret = pyotp.random_base32()
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.twofa_secret = secret
    db.commit()
    return TwoFAResponse(secret=secret)


@app.post("/2fa/verify")
def verify_2fa(code: str, db: Session = Depends(get_db), user_id: int = 0):
    user = db.get(models.User, user_id)
    if not user or not user.twofa_secret:
        raise HTTPException(status_code=404, detail="User not found")
    if not pyotp.TOTP(user.twofa_secret).verify(code):
        raise HTTPException(status_code=400, detail="Invalid code")
    return {"detail": "2FA enabled"}


# Role management --------------------------------------------------------
@app.post("/roles", status_code=status.HTTP_201_CREATED)
def create_role(role: RoleCreate, db: Session = Depends(get_db)):
    db_role = models.Role(name=role.name, description=role.description)
    db.add(db_role)
    db.commit()
    db.refresh(db_role)
    return {"id": db_role.id, "name": db_role.name}


@app.post("/users/{user_id}/roles/{role_id}")
def assign_role(user_id: int, role_id: int, db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    role = db.get(models.Role, role_id)
    if not user or not role:
        raise HTTPException(status_code=404, detail="User or role not found")
    user.roles.append(role)
    db.commit()
    return {"detail": "role assigned"}


@app.delete("/users/{user_id}/roles/{role_id}")
def remove_role(user_id: int, role_id: int, db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    role = db.get(models.Role, role_id)
    if not user or not role:
        raise HTTPException(status_code=404, detail="User or role not found")
    if role in user.roles:
        user.roles.remove(role)
        db.commit()
    return {"detail": "role removed"}
