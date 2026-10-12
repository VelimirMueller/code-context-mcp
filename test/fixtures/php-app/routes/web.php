<?php

use App\Http\Controllers\OrderController;
use Illuminate\Support\Facades\Route;

Route::get('/orders/{order}', [OrderController::class, 'show']);
// String controller reference (old style) must not create an edge:
Route::get('/legacy', 'App\Services\OrderService@place');
