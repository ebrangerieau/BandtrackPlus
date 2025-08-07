from alembic import op
import sqlalchemy as sa

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None

def upgrade():
    op.create_table(
        'roles',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(), nullable=False, unique=True),
        sa.Column('description', sa.String())
    )
    op.create_table(
        'users',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('username', sa.String(), nullable=False, unique=True),
        sa.Column('email', sa.String(), unique=True),
        sa.Column('password_hash', sa.String(), nullable=False),
        sa.Column('twofa_secret', sa.String())
    )
    op.create_table(
        'user_roles',
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('role_id', sa.Integer(), sa.ForeignKey('roles.id', ondelete='CASCADE'), primary_key=True)
    )
    op.create_table(
        'invitations',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('email', sa.String(), nullable=False),
        sa.Column('token', sa.String(), nullable=False, unique=True),
        sa.Column('role_id', sa.Integer(), sa.ForeignKey('roles.id')),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
        sa.Column('used', sa.Boolean(), server_default=sa.text('false'))
    )
    # Enable row level security and simple policies
    op.execute("ALTER TABLE users ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE roles ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE invitations ENABLE ROW LEVEL SECURITY")
    op.execute("CREATE POLICY user_is_self ON users USING (id = current_setting('app.user_id')::int)")
    op.execute("CREATE POLICY all_roles_read ON roles FOR SELECT USING (true)")
    op.execute("CREATE POLICY invitation_owner ON invitations USING (true)")

def downgrade():
    op.execute("DROP POLICY IF EXISTS invitation_owner ON invitations")
    op.execute("DROP POLICY IF EXISTS all_roles_read ON roles")
    op.execute("DROP POLICY IF EXISTS user_is_self ON users")
    op.execute("ALTER TABLE invitations DISABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE roles DISABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE users DISABLE ROW LEVEL SECURITY")
    op.drop_table('invitations')
    op.drop_table('user_roles')
    op.drop_table('users')
    op.drop_table('roles')
