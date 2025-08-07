import datetime as dt
from sqlalchemy import (
    Column,
    Integer,
    String,
    Boolean,
    ForeignKey,
    DateTime,
    Table,
)
from sqlalchemy.orm import relationship
from .database import Base

user_roles = Table(
    "user_roles",
    Base.metadata,
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role_id", ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    email = Column(String, unique=True, index=True, nullable=True)
    password_hash = Column(String, nullable=False)
    twofa_secret = Column(String, nullable=True)

    roles = relationship("Role", secondary=user_roles, back_populates="users")


class Role(Base):
    __tablename__ = "roles"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False)
    description = Column(String, nullable=True)

    users = relationship("User", secondary=user_roles, back_populates="roles")


class Invitation(Base):
    __tablename__ = "invitations"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, nullable=False)
    token = Column(String, unique=True, nullable=False)
    role_id = Column(Integer, ForeignKey("roles.id"), nullable=True)
    created_at = Column(DateTime, default=dt.datetime.utcnow)
    used = Column(Boolean, default=False)

    role = relationship("Role")
