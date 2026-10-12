<?php

namespace App\Http\Controllers;

use App\Models\Order;
use App\Services\OrderService;

class OrderController extends Controller
{
    public function __construct(private readonly OrderService $orders) {}

    public function show(Order $order): string
    {
        return money(100);
    }
}
