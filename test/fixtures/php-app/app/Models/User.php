<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use App\Concerns\HasUuid;

final class User extends Model
{
    use HasUuid;

    public function orders()
    {
        // same namespace, no use statement
        return $this->hasMany(Order::class);
    }
}
