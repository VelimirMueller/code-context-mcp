<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Enums\OrderStatus;

#[\Illuminate\Database\Eloquent\Attributes\ObservedBy]
class Order extends Model implements \App\Contracts\HasEvents
{
    use \App\Concerns\HasUuid, Auditable {
        Auditable::audit as protected runAudit;
    }

    protected $casts = ['status' => OrderStatus::class];

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function events(): array
    {
        return [];
    }
}
