create table if not exists users(id serial primary key,phone text unique not null,name text not null,pass_hash text not null,
 role text not null default 'customer',wallet int not null default 0 check(wallet>=0),points int not null default 0 check(points>=0),
 bday date,sub_until timestamptz,created_at timestamptz default now());
create table if not exists menu(id serial primary key,name text not null,price int not null,emoji text,cat text,food boolean default false,active boolean default true);
create table if not exists orders(id serial primary key,code text unique not null,user_id int references users(id),items jsonb not null,
 subtotal int,discount int,total int,slot text,pay text,earn int default 0,status text default 'menunggu_bayar',paid boolean default false,created_at timestamptz default now());
create table if not exists payments(ref text primary key,user_id int references users(id),kind text not null,amount int not null,bonus int default 0,
 order_id int,status text default 'pending',created_at timestamptz default now());
create table if not exists gifts(code text primary key,val int not null,created_by int references users(id),claimed_by int references users(id),
 used boolean default false,created_at timestamptz default now());
create index if not exists orders_status_idx on orders(status,created_at);
